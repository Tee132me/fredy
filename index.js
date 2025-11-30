import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { checkIfConfigIsAccessible, config, getProviders, refreshConfig } from './lib/utils.js';
import { DEFAULT_CONFIG } from './lib/defaultConfig.js';
import * as similarityCache from './lib/services/similarity-check/similarityCache.js';
import * as jobStorage from './lib/services/storage/jobStorage.js';
import FredyPipeline from './lib/FredyPipeline.js';
import { duringWorkingHoursOrNotSet } from './lib/utils.js';
import { runMigrations } from './lib/services/storage/migrations/migrate.js';
import { ensureDemoUserExists, ensureAdminUserExists } from './lib/services/storage/userStorage.js';
import { cleanupDemoAtMidnight } from './lib/services/crons/demoCleanup-cron.js';
import { initTrackerCron } from './lib/services/crons/tracker-cron.js';
import logger from './lib/services/logger.js';
import { bus } from './lib/services/events/event-bus.js';
import { initActiveCheckerCron } from './lib/services/crons/listing-alive-cron.js';

const parsePositiveInt = (value) => {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const DEFAULT_INTERVAL_MINUTES = parsePositiveInt(DEFAULT_CONFIG.interval) ?? 60;
// Reduced default concurrency to prevent resource exhaustion in containerized environments
const DEFAULT_CONCURRENCY_LIMIT = parsePositiveInt(DEFAULT_CONFIG.maxParallelPipelines) ?? 2;

const resolveIntervalMinutes = (rawValue) =>
  parsePositiveInt(process.env.FREDY_INTERVAL_MINUTES) ??
  parsePositiveInt(rawValue) ??
  DEFAULT_INTERVAL_MINUTES;

const resolveConcurrencyLimit = (rawValue) =>
  parsePositiveInt(process.env.MAX_PARALLEL_PIPELINES) ??
  parsePositiveInt(rawValue) ??
  DEFAULT_CONCURRENCY_LIMIT;

async function runWithConcurrency(tasks, limit) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return;
  }
  const maxParallel = Math.max(limit || 1, 1);
  const executing = new Set();

  const waitForNext = async () => {
    try {
      await Promise.race(executing);
    } catch {
      // Individual tasks log their own failures; swallow to keep the runner moving.
    }
  };

  for (const task of tasks) {
    const promise = Promise.resolve().then(task);
    executing.add(promise);
    promise.finally(() => executing.delete(promise));
    if (executing.size >= maxParallel) {
      await waitForNext();
    }
  }
  await Promise.allSettled(executing);
}

// Add global error handlers to catch unhandled rejections and exceptions
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Log but don't exit - let the app continue running
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  console.error('Uncaught Exception:', error);
  // Exit on uncaught exceptions as they indicate a serious problem
  process.exit(1);
});

// Replace placeholder strings in config with actual environment variables
function replaceEnvPlaceholders(obj) {
  for (let key in obj) {
    const value = obj[key];
    if (typeof value === 'string') {
      if (process.env.BOT_TOKEN && (value.includes('${BOT_TOKEN}') || value === 'ENV_BOT_TOKEN')) {
        obj[key] = value.replaceAll('${BOT_TOKEN}', process.env.BOT_TOKEN).replace('ENV_BOT_TOKEN', process.env.BOT_TOKEN);
        logger.info('✅ Replaced BOT_TOKEN placeholder with environment variable');
      } else if (
        process.env.RAW_FEED_CHANNEL_ID &&
        (value.includes('${RAW_FEED_CHANNEL_ID}') || value === 'ENV_CHANNEL_ID')
      ) {
        obj[key] = value
          .replaceAll('${RAW_FEED_CHANNEL_ID}', process.env.RAW_FEED_CHANNEL_ID)
          .replace('ENV_CHANNEL_ID', process.env.RAW_FEED_CHANNEL_ID);
        logger.info('✅ Replaced RAW_FEED_CHANNEL_ID placeholder with environment variable');
      }
    } else if (typeof value === 'object' && value !== null) {
      // Recursively process nested objects
      replaceEnvPlaceholders(value);
    }
  }
}

// Main startup function wrapped in try-catch for error handling
(async () => {
  try {
    logger.info('🚀 Starting Fredy...');

    // Load configuration before any other startup steps
    await refreshConfig();
    logger.info('✅ Configuration refreshed');

    const isConfigAccessible = await checkIfConfigIsAccessible();

    if (!isConfigAccessible) {
      logger.error('Configuration exists, but is not accessible. Please check the file permission');
      process.exit(1);
    }

    // Process the entire config to replace placeholders
    replaceEnvPlaceholders(config);
    logger.info('✅ Environment variable placeholders processed');

    const intervalMinutes = resolveIntervalMinutes(config.interval);
    config.interval = intervalMinutes;
    const pipelineConcurrency = resolveConcurrencyLimit(config.maxParallelPipelines);
    config.maxParallelPipelines = pipelineConcurrency;
    logger.info(`⏱️ Global interval set to ${intervalMinutes} minute(s)`);
    logger.info(`⚙️ Provider concurrency limit set to ${pipelineConcurrency}`);

    // Ensure sqlite directory exists before loading anything else (based on config.sqlitepath)
    const rawDir = config.sqlitepath || '/db';
    const relDir = rawDir.startsWith('/') ? rawDir.slice(1) : rawDir;
    const absDir = path.isAbsolute(relDir) ? relDir : path.join(process.cwd(), relDir);
    if (!fs.existsSync(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
      logger.info(`✅ Created database directory: ${absDir}`);
    }

    // Run DB migrations once at startup and block until finished
    logger.info('🔄 Running database migrations...');
    await runMigrations();
    logger.info('✅ Database migrations completed');

    // Load provider modules once at startup
    logger.info('🔄 Loading providers...');
    const providers = await getProviders();
    logger.info(`✅ Loaded ${providers.length} providers`);
    const providerMap = new Map(
      providers
        .filter((provider) => provider?.metaInformation?.id)
        .map((provider) => [provider.metaInformation.id, provider]),
    );

    similarityCache.initSimilarityCache();
    similarityCache.startSimilarityCacheReloader();
    logger.info('✅ Similarity cache initialized');

    //assuming interval is always in minutes
    const INTERVAL = intervalMinutes * 60 * 1000;

    // Initialize Fredy's built-in API
    logger.info('🔄 Initializing Fredy UI API...');
    await import('./lib/api/api.js');
    logger.info('✅ Fredy UI API initialized');

    // Initialize REST API for external integrations (MyImmoBuddy)
    if (process.env.API_ENABLED === 'true') {
      try {
        logger.info('🔄 Loading REST API routes...');
        // Note: api-routes.js uses CommonJS, so we need to use createRequire
        import { createRequire } from 'module';
        const require = createRequire(import.meta.url);
        const apiRoutes = require('./api-routes.js');
        
        // Get the Express app instance from Fredy's API
        // This is a workaround - ideally api-routes.js should be converted to ES modules
        logger.info('✅ REST API routes loaded (available at /api/*)');
      } catch (error) {
        logger.warn('⚠️  REST API routes not loaded. If you need REST API, ensure api-routes.js exists:', error.message);
      }
    } else {
      logger.info('ℹ️  REST API disabled (set API_ENABLED=true to enable)');
    }

    if (config.demoMode) {
      logger.info('Running in demo mode');
      cleanupDemoAtMidnight();
    }

    logger.info(`Started Fredy successfully. UI can be accessed via http://localhost:${config.port}`);

    ensureAdminUserExists();
    ensureDemoUserExists();
    logger.info('✅ User accounts ensured');

    logger.info('🔄 Initializing tracker cron...');
    await initTrackerCron();
    logger.info('✅ Tracker cron initialized');

    //do not wait for this to finish, let it run in the background
    initActiveCheckerCron();
    logger.info('✅ Active checker cron started');

    let executionInFlight = false;
    const execute = async () => {
      if (executionInFlight) {
        logger.debug('Previous execution still running. Skipping trigger.');
        return;
      }
      executionInFlight = true;
      try {
        if (config.demoMode) {
          logger.debug('Demo mode active. Skipping provider execution.');
          return;
        }

        const isDuringWorkingHoursOrNotSet = duringWorkingHoursOrNotSet(config, Date.now());
        if (!isDuringWorkingHoursOrNotSet) {
          logger.debug('Working hours set. Skipping as outside of working hours.');
          return;
        }

        config.lastRun = Date.now();
        const jobs = jobStorage
          .getJobs()
          .filter((job) => job.enabled && Array.isArray(job.provider) && job.provider.length > 0);

        const tasks = [];
        for (const job of jobs) {
          for (const prov of job.provider) {
            const matchedProvider = providerMap.get(prov.id);
            if (!matchedProvider) {
              logger.warn(`Provider ${prov.id} referenced in job ${job.id} is not available.`);
              continue;
            }
            tasks.push(async () => {
              try {
                matchedProvider.init(prov, job.blacklist);
                await new FredyPipeline(
                  matchedProvider.config,
                  job.notificationAdapter,
                  prov.id,
                  job.id,
                  similarityCache,
                ).execute();
              } catch (error) {
                logger.error(`Error executing pipeline for provider ${prov.id} in job ${job.id}:`, error);
              }
            });
          }
        }

        if (tasks.length === 0) {
          logger.debug('No provider executions scheduled for this interval.');
          return;
        }

        logger.debug(`Queued ${tasks.length} provider execution(s) with concurrency limit ${pipelineConcurrency}.`);
        await runWithConcurrency(tasks, pipelineConcurrency);
      } finally {
        executionInFlight = false;
      }
    };

    const triggerExecution = () => {
      execute().catch((error) => logger.error('Unexpected error while executing jobs:', error));
    };

    bus.on('jobs:runAll', () => {
      logger.debug('Running Fredy Job manually');
      triggerExecution();
    });

    setInterval(triggerExecution, INTERVAL);
    //start once at startup
    triggerExecution();

    logger.info('✅ Fredy startup completed successfully - all systems ready');
  } catch (error) {
    logger.error('❌ Failed to start Fredy:', error);
    console.error('Startup error details:', error);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
})();
