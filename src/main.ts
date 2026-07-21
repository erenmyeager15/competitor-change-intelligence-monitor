import { Actor, log } from 'apify';
import { parseActorInput } from './input.js';
import { runMonitor, type PushResult } from './runtime.js';
import { redactText } from './security/redaction.js';

const STATE_STORE_NAME = 'competitor-change-intelligence-state';

await Actor.init();

try {
  const input = parseActorInput((await Actor.getInput<unknown>()) ?? {});
  const outputStore = await Actor.openKeyValueStore();
  const stateStore = await Actor.openKeyValueStore(STATE_STORE_NAME);
  const chargingManager = Actor.getChargingManager();
  const pricing = chargingManager.getPricingInfo();
  const environment = Actor.getEnv();
  const runUrl = environment.actorRunId ? `https://console.apify.com/view/runs/${environment.actorRunId}` : null;

  log.info('Starting bounded competitor change intelligence run.', {
    targetCount: input.targets.length,
    baselineAction: input.baselineAction,
    notificationMode: input.notificationMode,
    dryRun: input.dryRun,
  });

  const result = await runMonitor(input, {
    stateStore,
    billingEnabled: pricing.isPayPerEvent,
    getChargeableCount: (eventName) => chargingManager.calculateMaxEventChargeCountWithinLimit(eventName),
    pushData: async (report, eventName): Promise<PushResult> => {
      if (eventName) return Actor.pushData({ ...report }, eventName);
      await Actor.pushData({ ...report });
      return { chargedCount: 0, eventChargeLimitReached: false, chargeableWithinLimit: {} };
    },
    setOutputValue: async (key, value, contentType) => {
      if (contentType === 'application/json') {
        await outputStore.setValue(key, value);
      } else {
        await outputStore.setValue(key, String(value), { contentType });
      }
    },
    runUrl,
  });

  await Actor.setStatusMessage(
    `Processed ${result.summary.processedTargetCount}/${result.summary.targetCount} targets; `
    + `${result.summary.chargedEventCount} paid page check(s); delivery ${result.summary.delivery.status}.`,
  );
  log.info('Competitor change intelligence run finished.', {
    processedTargetCount: result.summary.processedTargetCount,
    persistedReportCount: result.summary.persistedReportCount,
    chargedEventCount: result.summary.chargedEventCount,
    skippedForChargeLimit: result.summary.skippedForChargeLimit,
    deliveryStatus: result.summary.delivery.status,
  });
} catch (error) {
  const message = redactText((error as Error)?.message ?? 'Actor run failed.', 500);
  log.error('Competitor change intelligence run failed.', { error: message });
  await Actor.fail(message);
}

await Actor.exit();
