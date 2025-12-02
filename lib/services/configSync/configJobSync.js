/**
 * Config Job Sync Service
 * Syncs jobs from config.json to the database and watches for changes
 */

import fs from 'fs';
import path from 'path';
import { getDirName } from '../../utils.js';
import { refreshConfig, readConfigFromStorage } from '../../utils.js';
import { upsertJob, getJob, getJobs, removeJob } from '../storage/jobStorage.js';
import { upsertUser, getUser } from '../storage/userStorage.js';
import logger from '../logger.js';

const CONFIG_SYNC_USER_ID = 'config_sync';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(getDirName(), '../../../conf/config.json');

let fileWatcher = null;
let syncInProgress = false;
let lastSyncTime = null;

/**
 * Replace environment variable placeholders in an object (simple version for file change syncs)
 */
function replaceEnvPlaceholdersSimple(obj) {
  for (const key in obj) {
    const value = obj[key];
    if (typeof value === 'string') {
      if (process.env.BOT_TOKEN && value.includes('${BOT_TOKEN}')) {
        obj[key] = value.replaceAll('${BOT_TOKEN}', process.env.BOT_TOKEN);
      }
      if (process.env.RAW_FEED_CHANNEL_ID && value.includes('${RAW_FEED_CHANNEL_ID}')) {
        obj[key] = value.replaceAll('${RAW_FEED_CHANNEL_ID}', process.env.RAW_FEED_CHANNEL_ID);
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      replaceEnvPlaceholdersSimple(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === 'object' && item !== null) {
          replaceEnvPlaceholdersSimple(item);
        }
      });
    }
  }
}

/**
 * Ensure the config_sync user exists
 */
function ensureConfigSyncUser() {
  const user = getUser(CONFIG_SYNC_USER_ID);
  if (!user) {
    upsertUser({
      userId: CONFIG_SYNC_USER_ID,
      username: 'config_sync',
      password: 'config_sync_' + Date.now(), // Random password (not used for login)
      isAdmin: false,
    });
    logger.info('✅ Created config_sync user for config.json job management');
  }
}

/**
 * Convert notification adapter from config.json format to database format
 * Config format: { "id": "telegram", "args": { "token": "...", "chatId": "..." } }
 * Global adapter format: { "type": "telegram", "botToken": "...", "chatId": "..." }
 * DB format: { "id": "telegram", "fields": { "token": "...", "chatId": "..." } }
 */
function convertNotificationAdapter(adapter) {
  if (!adapter) {
    return null;
  }

  // Handle global adapter format (uses "type" instead of "id")
  if (adapter.type && adapter.botToken && adapter.chatId) {
    return {
      id: adapter.type,
      fields: {
        token: adapter.botToken,
        chatId: adapter.chatId,
      },
    };
  }

  // Need at least an id
  if (!adapter.id) {
    return null;
  }

  // If already in DB format (has "fields"), return as-is
  if (adapter.fields) {
    return adapter;
  }

  // Convert from config format (has "args") to DB format
  if (adapter.args) {
    return {
      id: adapter.id,
      fields: adapter.args,
    };
  }

  // Fallback: return with empty fields
  return {
    id: adapter.id,
    fields: {},
  };
}

/**
 * Sync a single job from config.json to database
 * @param {Object} jobConfig - Job configuration from config.json
 * @param {Object} currentConfig - Current config object (to avoid stale imports)
 */
function syncJobToDatabase(jobConfig, currentConfig) {
  try {
    if (!jobConfig.id) {
      logger.warn('Skipping job without id:', jobConfig.name || 'unnamed');
      return false;
    }

    // Convert notification adapters
    const notificationAdapters = Array.isArray(jobConfig.notificationAdapter)
      ? jobConfig.notificationAdapter.map(convertNotificationAdapter).filter(Boolean)
      : [];

    // If no notification adapters, use the global adapters from currentConfig
    if (notificationAdapters.length === 0 && currentConfig && currentConfig.adapters) {
      currentConfig.adapters.forEach((adapter) => {
        const converted = convertNotificationAdapter(adapter);
        if (converted) {
          notificationAdapters.push(converted);
        }
      });
    }

    // Ensure we have at least one notification adapter
    if (notificationAdapters.length === 0) {
      logger.warn(`Job ${jobConfig.id} has no notification adapters, skipping`);
      return false;
    }

    // Upsert job to database
    upsertJob({
      jobId: jobConfig.id,
      name: jobConfig.name || jobConfig.id,
      enabled: jobConfig.enabled !== false, // Default to true if not specified
      provider: jobConfig.provider || [],
      notificationAdapter: notificationAdapters,
      userId: CONFIG_SYNC_USER_ID,
      shareWithUsers: jobConfig.user_ids || [],
      blacklist: jobConfig.blacklist || [],
    });

    return true;
  } catch (error) {
    logger.error(`Error syncing job ${jobConfig.id}:`, error);
    return false;
  }
}

/**
 * Sync all jobs from config.json to database
 */
async function syncConfigJobsToDatabase() {
  if (syncInProgress) {
    logger.debug('Config sync already in progress, skipping...');
    return;
  }

  syncInProgress = true;
  try {
    logger.info('🔄 Syncing jobs from config.json to database...');

    // Ensure config_sync user exists
    ensureConfigSyncUser();

    // Refresh config to get latest from file (in case it changed)
    await refreshConfig();
    
    // Read fresh config after refresh (imported config binding may be stale after reassignment)
    // When refreshConfig() does `config = await readConfigFromStorage()`, it reassigns the variable
    // in utils.js, but the imported binding in this module still points to the old object.
    const currentConfig = await readConfigFromStorage();
    
    // Replace environment variable placeholders
    replaceEnvPlaceholdersSimple(currentConfig);

    // Get jobs from config
    const configJobs = currentConfig.jobs || [];

    if (configJobs.length === 0) {
      logger.info('ℹ️  No jobs found in config.json');
      syncInProgress = false;
      return;
    }

    // Get existing config-synced jobs from database
    const existingJobs = getJobs().filter((job) => job.userId === CONFIG_SYNC_USER_ID);
    const existingJobIds = new Set(existingJobs.map((job) => job.id));
    const configJobIds = new Set(configJobs.map((job) => job.id));

    // Sync each job from config
    let syncedCount = 0;
    let skippedCount = 0;

    for (const jobConfig of configJobs) {
      if (syncJobToDatabase(jobConfig, currentConfig)) {
        syncedCount++;
      } else {
        skippedCount++;
      }
    }

    // Remove jobs from database that are no longer in config.json
    const jobsToRemove = existingJobs.filter((job) => !configJobIds.has(job.id));
    for (const job of jobsToRemove) {
      logger.info(`🗑️  Removing job ${job.id} (no longer in config.json)`);
      removeJob(job.id);
    }

    lastSyncTime = Date.now();
    logger.info(
      `✅ Config sync completed: ${syncedCount} jobs synced, ${skippedCount} skipped, ${jobsToRemove.length} removed`,
    );
  } catch (error) {
    logger.error('Error syncing config jobs:', error);
  } finally {
    syncInProgress = false;
  }
}

/**
 * Start watching config.json for changes
 */
function startConfigFileWatcher() {
  if (fileWatcher) {
    logger.debug('Config file watcher already running');
    return;
  }

  try {
    // Check if file exists before watching
    if (!fs.existsSync(CONFIG_PATH)) {
      logger.warn(`Config file not found at ${CONFIG_PATH}, file watcher not started`);
      return;
    }

    // Use fs.watch for cross-platform file watching
    let debounceTimer = null;
    fileWatcher = fs.watch(CONFIG_PATH, { persistent: true }, (eventType, filename) => {
      if (eventType === 'change' && filename) {
        // Clear existing timer
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        // Debounce: wait 2 seconds before syncing to avoid multiple rapid syncs
        debounceTimer = setTimeout(() => {
          logger.info('📝 Config file changed, syncing jobs...');
          syncConfigJobsToDatabase().catch((error) => {
            logger.error('Error during config file change sync:', error);
          });
        }, 2000);
      }
    });

    logger.info('✅ Started watching config.json for changes');
  } catch (error) {
    logger.warn('Could not start config file watcher (this is normal in some environments):', error.message);
    logger.info('ℹ️  Jobs will still sync on startup. Manual restart required for config changes.');
  }
}

/**
 * Stop watching config.json
 */
function stopConfigFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
    logger.info('Stopped watching config.json');
  }
}

/**
 * Initialize config job sync (call on startup)
 */
export async function initConfigJobSync() {
  try {
    // Sync jobs on startup
    await syncConfigJobsToDatabase();

    // Start watching for changes
    startConfigFileWatcher();
  } catch (error) {
    logger.error('Error initializing config job sync:', error);
  }
}

/**
 * Get last sync time
 */
export function getLastSyncTime() {
  return lastSyncTime;
}

/**
 * Manually trigger a sync (useful for testing or API endpoints)
 */
export async function triggerSync() {
  await syncConfigJobsToDatabase();
}

/**
 * Cleanup (call on shutdown)
 */
export function cleanup() {
  stopConfigFileWatcher();
}
