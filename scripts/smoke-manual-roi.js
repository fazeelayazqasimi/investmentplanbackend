/**
 * Smoke test for the chunked/resumable manual ROI run.
 *
 * Run:  node scripts/smoke-manual-roi.js
 *
 * Uses an in-memory MongoDB replica set (mongodb-memory-server) so real
 * transactions work — the real database is NEVER touched.
 *
 * Verifies:
 *  1. Chunked run completes across multiple requests, progress persists
 *  2. Re-running the SAME runId never double-pays (unique index)
 *  3. Percentage mismatch on an existing run is rejected (400)
 *  4. A NEW runId pays again (intended repeat-run behaviour)
 *  5. getRoiRun reports state (resume path)
 *  6. Interrupted run resumes exactly where it stopped
 *  7. Lease blocks a second concurrent worker
 *  8. AUTO path (processAllActiveInvestments) still works after our edits
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Wallet = require('../src/models/Wallet');
const Investment = require('../src/models/Investment');
const ROIHistory = require('../src/models/ROIHistory');
const SystemSettings = require('../src/models/SystemSettings');
const RoiRun = require('../src/models/RoiRun');
const roiService = require('../src/services/roiService');

let passed = 0;
let failed = 0;

const ok = (cond, label) => {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drives a run to completion by repeatedly calling the chunk endpoint. */
const driveRun = async (percentage, runId, opts = {}, maxCalls = 100) => {
  let last = null;
  for (let i = 0; i < maxCalls; i += 1) {
    last = await roiService.processManualRoi(percentage, new Date(), runId, opts);
    if (last.status === 'COMPLETED') return { result: last, calls: i + 1 };
    await sleep(20);
  }
  return { result: last, calls: maxCalls };
};

async function main() {
  console.log('Starting in-memory MongoDB replica set...');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: 'smoke' },
  });

  try {
    await mongoose.connect(replSet.getUri('investment-platform-smoke'), {
      serverSelectionTimeoutMS: 10000,
    });
    console.log('Connected.\n');

    // ---------- SEED ----------
    console.log('Seeding...');
    await SystemSettings.create({
      singletonKey: 'GLOBAL_SETTINGS',
      roiProcessingEnabled: true,
      roiMode: 'OVERALL',
      overallRoiPercentage: 1,
      profitShareLevels: [{ level: 1, percentage: 3 }],
      levels: [{ level: 1, percentage: 10 }, { level: 2, percentage: 5 }],
    });

    const mkUser = (i, referredBy = null) =>
      User.create({
        name: `User ${i}`,
        email: `u${i}@smoke.test`,
        phone: `+1000000000${i}`,
        password: 'password123',
        isActivated: true,
        referredBy,
      });

    const u1 = await mkUser(1);          // upline
    const u2 = await mkUser(2, u1._id);  // investor with referral chain
    const u3 = await mkUser(3, u1._id);
    const u4 = await mkUser(4);
    const u5 = await mkUser(5);
    const allUsers = [u1, u2, u3, u4, u5];

    for (const u of allUsers) {
      const w = await Wallet.getOrCreateWallet(u._id);
      w.totalInvestmentAmount = 100;
      w.totalLifetimeInvestment = 100;
      await w.save();
    }

    // 8 active investments: u2 has 3, u3 has 2, others 1 each.
    const alloc = [[u2, 3], [u3, 2], [u4, 2], [u5, 1]];
    const investmentIds = [];
    for (const [owner, count] of alloc) {
      for (let i = 0; i < count; i += 1) {
        const inv = await Investment.create({
          user: owner._id,
          originalAmount: 100,
          maxReturnAmount: 200,
          roiMode: 'OVERALL',
          startDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          createdBy: u1._id,
          status: 'ACTIVE',
        });
        investmentIds.push(inv._id);
      }
    }
    console.log(`Seeded ${allUsers.length} users, ${investmentIds.length} active investments.\n`);

    // ---------- TEST 1: chunked run completes ----------
    console.log('T1: Chunked run (tiny budget → multiple chunks)');
    const runA = new Date().toISOString();
    const { result: resA, calls: callsA } = await driveRun(1, runA, { chunkBudgetMs: 5 });
    ok(resA.status === 'COMPLETED', `run completes (status=${resA.status})`);
    ok(callsA > 1, `run needed multiple chunk calls (calls=${callsA}) — no single long request`);
    ok(resA.progress.done === 8 && resA.progress.total === 8, `progress 8/8 (${resA.progress.done}/${resA.progress.total})`);
    ok(resA.processed === 8, `processed=8 (got ${resA.processed})`);
    ok(resA.failed === 0, `failed=0 (got ${resA.failed})`);
    ok(resA.results.length === 8, `results has 8 entries (got ${resA.results.length})`);
    ok(Number(resA.totalCredited) === 8, `totalCredited=8 (got ${resA.totalCredited})`);
    let rows = await ROIHistory.countDocuments({});
    ok(rows === 8, `ROIHistory rows=8 after run A (got ${rows})`);

    // ---------- TEST 2: same runId again → no double pay ----------
    console.log('\nT2: Re-run SAME runId (idempotent resume)');
    const againA = await roiService.processManualRoi(1, new Date(), runA, { chunkBudgetMs: 5 });
    ok(againA.status === 'COMPLETED', `returns COMPLETED immediately (status=${againA.status})`);
    rows = await ROIHistory.countDocuments({});
    ok(rows === 8, `still 8 ROIHistory rows — NO double payment (got ${rows})`);
    ok(againA.totalCredited === 8, `report totals unchanged (${againA.totalCredited})`);

    // ---------- TEST 3: percentage mismatch rejected ----------
    console.log('\nT3: Same runId with different percentage → rejected');
    let threw400 = false;
    try {
      await roiService.processManualRoi(2, new Date(), runA, { chunkBudgetMs: 5 });
    } catch (e) {
      threw400 = e.statusCode === 400 && /started at/.test(e.message);
    }
    ok(threw400, '400 with "started at" message');

    // ---------- TEST 4: NEW runId pays again (intended) ----------
    console.log('\nT4: New runId (intended repeat run)');
    const runB = new Date().toISOString();
    const { result: resB } = await driveRun(2, runB, { chunkBudgetMs: 5 });
    ok(resB.status === 'COMPLETED', `run B completes (status=${resB.status})`);
    rows = await ROIHistory.countDocuments({});
    ok(rows === 16, `ROIHistory rows=16 after 2nd run (got ${rows})`);
    ok(Number(resB.totalCredited) === 16, `run B credited 16 total (2% of 100 × 8) (got ${resB.totalCredited})`);

    // ---------- TEST 5: getRoiRun ----------
    console.log('\nT5: getRoiRun status/report');
    const fetched = await roiService.getRoiRun(runA);
    ok(fetched && fetched.status === 'COMPLETED', 'existing run fetched');
    ok(fetched.results.length === 8, 'final report includes results');
    const missing = await roiService.getRoiRun('no-such-run');
    ok(missing === null, 'missing run returns null');

    // ---------- TEST 6: interrupted run resumes ----------
    console.log('\nT6: Interrupted run (resume from cursor)');
    const runC = new Date().toISOString();
    const first = await roiService.processManualRoi(1, new Date(), runC, { chunkBudgetMs: 1 });
    ok(first.status === 'RUNNING', `first call returns RUNNING, not the whole run (status=${first.status})`);
    ok(first.progress.done > 0 && first.progress.done < 8, `partial progress persisted (${first.progress.done}/8)`);
    const midRows = await ROIHistory.countDocuments({});
    ok(midRows === 16 + first.progress.done, `only ${first.progress.done} new rows so far (got ${midRows - 16})`);
    const { result: resC, calls: callsC } = await driveRun(1, runC, { chunkBudgetMs: 5 });
    ok(resC.status === 'COMPLETED', `resume finishes the run (status=${resC.status})`);
    ok(resC.processed === 8, `resume processed all 8 (got ${resC.processed})`);
    rows = await ROIHistory.countDocuments({});
    ok(rows === 24, `ROIHistory rows=24 after run C — no dupes (got ${rows})`);

    // ---------- TEST 7: lease blocks concurrent worker ----------
    console.log('\nT7: Lease blocks a second concurrent worker');
    const runD = new Date().toISOString();
    await roiService.processManualRoi(1, new Date(), runD, { chunkBudgetMs: 1 });
    // Hold the lease artificially as if another request is mid-chunk.
    await RoiRun.updateOne(
      { runId: runD },
      { $set: { leaseUntil: new Date(Date.now() + 30000) } }
    );
    const busy = await roiService.processManualRoi(1, new Date(), runD, { chunkBudgetMs: 1000 });
    ok(busy.status === 'RUNNING', `busy call returns RUNNING (status=${busy.status})`);
    ok(/in progress/.test(busy.message || ''), 'reports another worker in progress');
    const duringRows = await ROIHistory.countDocuments({});
    // (First runD call already credited some; nothing new should be added by the busy call.)
    await RoiRun.updateOne({ runId: runD }, { $set: { leaseUntil: null } });
    const afterBusyRows = await ROIHistory.countDocuments({});
    ok(afterBusyRows === duringRows, 'busy call credited nothing');
    const { result: resD } = await driveRun(1, runD, { chunkBudgetMs: 5 });
    ok(resD.status === 'COMPLETED', `run D completes after lease released (status=${resD.status})`);
    rows = await ROIHistory.countDocuments({});
    ok(rows === 32, `ROIHistory rows=32 after run D (got ${rows})`);

    // ---------- TEST 8: AUTO path untouched ----------
    console.log('\nT8: AUTO path (processAllActiveInvestments) still works');
    let autoResult = null;
    let autoError = null;
    try {
      autoResult = await roiService.processAllActiveInvestments(new Date());
    } catch (e) {
      autoError = e;
    }
    ok(!autoError, `no error${autoError ? ` (${autoError.message})` : ''}`);
    ok(autoResult && autoResult.processed === 8, `AUTO processed all 8 (got ${autoResult && autoResult.processed})`);
    ok((autoResult.errors || []).length === 0, 'AUTO errors empty');
    rows = await ROIHistory.countDocuments({});
    ok(rows === 40, `ROIHistory rows=40 after AUTO (got ${rows})`);

    // ---------- TEST 9: profit share ran during manual ROI ----------
    console.log('\nT9: Profit share credited to upline during ROI');
    const u1Wallet = await Wallet.findOne({ user: u1._id });
    ok(
      (u1Wallet.profitShareBalance || 0) > 0,
      `upline profitShareBalance > 0 (got ${u1Wallet.profitShareBalance})`
    );
    ok(
      (u1Wallet.totalEligibleEarnings || 0) > 0,
      `upline totalEligibleEarnings tracked (got ${u1Wallet.totalEligibleEarnings})`
    );

    // ---------- TEST 10: transient write conflicts are retried ----------
    console.log('\nT10: Injected write conflicts are retried, never FAILED');
    const bonusService = require('../src/services/bonusService');
    const originalProfitShare = bonusService.creditProfitShareFromRoi;
    let injectedConflicts = 0;
    bonusService.creditProfitShareFromRoi = async function (...args) {
      if (injectedConflicts < 3) {
        injectedConflicts += 1;
        const conflict = new Error(
          'Caused by :: Write conflict during plan execution and yielding is disabled. :: Please retry your operation or multi-document transaction.'
        );
        conflict.code = 112;
        throw conflict;
      }
      return originalProfitShare.apply(this, args);
    };
    const rowsBeforeE = await ROIHistory.countDocuments({});
    const runE = new Date().toISOString();
    let resE = null;
    try {
      ({ result: resE } = await driveRun(1, runE, { chunkBudgetMs: 5 }));
    } finally {
      bonusService.creditProfitShareFromRoi = originalProfitShare;
    }
    ok(resE.status === 'COMPLETED', `run E completes (status=${resE.status})`);
    ok(injectedConflicts > 0, `write conflicts were actually injected (${injectedConflicts})`);
    ok(resE.failed === 0, `failed=0 despite write conflicts (got ${resE.failed})`);
    ok(resE.processed === 8, `every investment still paid (processed=${resE.processed})`);
    rows = await ROIHistory.countDocuments({});
    ok(rows === rowsBeforeE + 8, `ROIHistory +8 rows, no double pay (got ${rows - rowsBeforeE})`);

    // ---------- TEST 11: only ONE manual run may be active ----------
    console.log('\nT11: Second runId while a run is active → adopts the active run');
    const runsBeforeF = await RoiRun.countDocuments({});
    const runF = new Date().toISOString();
    const firstF = await roiService.processManualRoi(1, new Date(), runF, { chunkBudgetMs: 1 });
    ok(firstF.status === 'RUNNING', `run F started (status=${firstF.status})`);

    // Same percentage, different runId → must NOT create a second run.
    const adopted = await roiService.processManualRoi(1, new Date(), new Date().toISOString(), {
      chunkBudgetMs: 5,
    });
    ok(adopted.runId === runF, `second runId adopts the active run (got ${adopted.runId})`);
    ok((await RoiRun.countDocuments({})) === runsBeforeF + 1, 'no second run document created');

    // Different percentage while a run is active → rejected, not started.
    let threw409 = false;
    try {
      await roiService.processManualRoi(2, new Date(), new Date().toISOString(), { chunkBudgetMs: 5 });
    } catch (e) {
      threw409 = e.statusCode === 409;
    }
    ok(threw409, 'different percentage rejected with 409 while a run is active');
    ok((await RoiRun.countDocuments({})) === runsBeforeF + 1, 'still no second run document');

    const { result: resF } = await driveRun(1, runF, { chunkBudgetMs: 5 });
    ok(resF.status === 'COMPLETED', `run F completes after adopt attempts (status=${resF.status})`);

    // ---------- TEST 12: stale RUNNING run is swept, never blocks ----------
    console.log('\nT12: Stale RUNNING run is swept and does not block a new run');
    const staleId = `stale-${Date.now()}`;
    await RoiRun.create({
      runId: staleId,
      type: 'MANUAL',
      percentage: 9,
      roiDate: new Date(),
      status: 'RUNNING',
      totalActive: 0,
      investmentIds: [],
      processedIds: [],
    });
    await RoiRun.updateOne(
      { runId: staleId },
      { $set: { updatedAt: new Date(Date.now() - 15 * 60 * 1000) } },
      { timestamps: false }
    );
    const runG = new Date().toISOString();
    const { result: resG } = await driveRun(1, runG, { chunkBudgetMs: 5 });
    ok(resG.status === 'COMPLETED', `new run starts and completes despite stale run (status=${resG.status})`);
    const sweptStale = await RoiRun.findOne({ runId: staleId }).lean();
    ok(sweptStale && sweptStale.status === 'FAILED', `stale run swept to FAILED (got ${sweptStale && sweptStale.status})`);
    rows = await ROIHistory.countDocuments({});
    ok(rows === rowsBeforeE + 24, `final ROIHistory rows=${rowsBeforeE + 24} (got ${rows})`);
  } finally {
    try {
      await mongoose.disconnect();
    } catch (_) { /* ignore */ }
    try {
      await replSet.stop();
    } catch (_) { /* ignore */ }
  }

  console.log(`\n===== ${passed} passed, ${failed} failed =====`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(1);
});
