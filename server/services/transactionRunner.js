const mongoose = require('mongoose');

/**
 * Runs a unit of work inside a MongoDB transaction when the deployment supports
 * one, and falls back to running it without a session when it does not.
 *
 * `mongodb-memory-server` in its default standalone mode and a lot of small
 * self-hosted deployments are not replica sets, so a hard `withTransaction()` would
 * simply break order creation there. The probe below distinguishes the two cases:
 * a replica set (or mongos) supports transactions, a standalone raises
 * `IllegalOperation` and we permanently remember that fact.
 *
 * Correctness note: when the deployment rejects the transaction, *nothing* was
 * written, so re-running the callback without a session is safe. Business errors
 * thrown by the callback are never retried.
 */

let supportsTransactions; // undefined = not probed, true/false = known
let probe;

const DEPLOYMENT_ERROR_CODES = new Set([
  20, // IllegalOperation
  263, // OperationNotSupportedInTransaction
  'IllegalOperation',
  'OperationNotSupportedInTransaction',
]);

const looksLikeDeploymentLimit = (error = {}) => {
  if (DEPLOYMENT_ERROR_CODES.has(error.code) || DEPLOYMENT_ERROR_CODES.has(error.codeName)) {
    return true;
  }
  return /transaction numbers are only allowed|does not support transactions|transactions are not supported|not supported on standalone/i.test(
    String(error.message || '')
  );
};

const PROBE_COLLECTION = '__transaction_probe';

/**
 * Detects whether this deployment can actually run a transaction.
 *
 * A read is not enough to find out: on a standalone, `withTransaction()` happily
 * runs its callback and commits a no-op without complaint, because nothing that
 * was sent carried a transaction number. Only a real write exposes the truth -
 * the server rejects it with code 20 / "transaction numbers are only allowed on a
 * replica set member or mongos". Probing with a read would report "supported" and
 * then every order write would fail at runtime.
 */
const detectSupport = async () => {
  let session;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // The session MUST be passed to the write: a write that ignores it runs
      // outside the transaction, succeeds happily, and proves nothing.
      await mongoose.connection.db
        .collection(PROBE_COLLECTION)
        .insertOne({ at: new Date(), probe: true }, { session });
    });

    // It really was transactional, so clean up after ourselves.
    await mongoose.connection.db.collection(PROBE_COLLECTION).deleteMany({ probe: true });
    return true;
  } catch (error) {
    if (looksLikeDeploymentLimit(error)) return false;
    throw error;
  } finally {
    if (session) await session.endSession();
  }
};

const getSupport = async () => {
  if (supportsTransactions !== undefined) return supportsTransactions;
  if (!probe) {
    probe = detectSupport().then(
      (result) => {
        supportsTransactions = result;
        return result;
      },
      (error) => {
        probe = null; // allow a retry on the next request
        throw error;
      }
    );
  }
  return probe;
};

/**
 * @param {(session?: import('mongoose').ClientSession) => Promise<any>} work
 * @returns {Promise<any>} whatever `work` resolves to
 */
const runInTransaction = async (work) => {
  if (!(await getSupport())) {
    return work(undefined);
  }

  let session;
  let result;

  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (!looksLikeDeploymentLimit(error)) throw error;

    // The deployment refused to start a transaction, so nothing was applied.
    supportsTransactions = false;
    if (session) await session.endSession();
    session = null;
    return work(undefined);
  } finally {
    if (session) await session.endSession();
  }
};

/** Exposed for tests and for a startup log line. */
const resetProbe = () => {
  supportsTransactions = undefined;
  probe = null;
};

module.exports = { runInTransaction, resetProbe, getSupport };