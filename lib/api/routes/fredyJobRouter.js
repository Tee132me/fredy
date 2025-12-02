/**
 * Fredy Job Management API Router
 * External API for programmatic job management (for MyImmoBuddy integration)
 */

import restana from 'restana';
import fs from 'fs/promises';
import path from 'path';
import { getDirName } from '../../utils.js';
import { upsertJob, getJob, getJobs, removeJob } from '../../services/storage/jobStorage.js';
import { upsertUser, getUser } from '../../services/storage/userStorage.js';

const service = restana();
const router = service.newRouter();
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(getDirName(), '../../../conf/config.json');
const API_SECRET_KEY = process.env.API_SECRET_KEY || process.env.FREDY_API_KEY || 'your_secret_key';

let configCache = null;
let configLastModified = null;

/**
 * Middleware: Check if external API is enabled
 */
const checkExternalAPIEnabled = (req, res, next) => {
  const apiEnabled = process.env.API_ENABLED === 'true' || process.env.EXTERNAL_API_ENABLED === 'true';
  
  if (!apiEnabled) {
    return res.send({ error: 'External API is disabled' }, 403);
  }
  
  next();
};

/**
 * Middleware: Validate API key
 */
const validateAPIKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['x-fredy-api-key'];
  
  if (!apiKey || apiKey !== API_SECRET_KEY) {
    return res.send({ error: 'Unauthorized: Invalid API key' }, 401);
  }
  
  next();
};

/**
 * Load config from file
 */
async function loadConfig() {
  try {
    const stats = await fs.stat(CONFIG_PATH);
    
    if (configCache && configLastModified && stats.mtime <= configLastModified) {
      return configCache;
    }
    
    const data = await fs.readFile(CONFIG_PATH, 'utf8');
    configCache = JSON.parse(data);
    configLastModified = stats.mtime;
    
    return configCache;
  } catch (error) {
    console.error('Error loading config:', error);
    throw error;
  }
}

/**
 * Save config to file
 */
async function saveConfig(config) {
  try {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    configCache = config;
    configLastModified = new Date();
  } catch (error) {
    console.error('Error saving config:', error);
    throw error;
  }
}

// Apply middleware to all routes
router.use(checkExternalAPIEnabled);
router.use(validateAPIKey);

/**
 * GET /external/health - Health check
 */
router.get('/health', async (req, res) => {
  res.send({
    status: 'ok',
    timestamp: new Date().toISOString(),
    api_version: '1.0.0'
  });
});

/**
 * GET /external/jobs - List all jobs
 */
router.get('/jobs', async (req, res) => {
  try {
    const config = await loadConfig();
    const jobs = config.jobs || [];
    
    const jobSummaries = jobs.map(job => ({
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      interval: job.interval,
      user_ids: job.user_ids || [],
      property_type: job.property_type || 'UNKNOWN',
      provider_count: (job.provider || []).length
    }));
    
    res.send({ jobs: jobSummaries, total: jobSummaries.length });
  } catch (error) {
    console.error('Error listing jobs:', error);
    res.send({ error: 'Failed to list jobs' }, 500);
  }
});

/**
 * GET /external/jobs/:id - Get specific job
 */
router.get('/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const config = await loadConfig();
    const jobs = config.jobs || [];
    
    const job = jobs.find(j => j.id === id);
    
    if (!job) {
      return res.send({ error: 'Job not found' }, 404);
    }
    
    res.send({ job });
  } catch (error) {
    console.error('Error getting job:', error);
    res.send({ error: 'Failed to get job' }, 500);
  }
});

/**
 * POST /external/jobs - Create new job
 */
router.post('/jobs', async (req, res) => {
  try {
    console.log('[External API] Received POST /api/external/jobs');
    console.log('[External API] Request body:', JSON.stringify(req.body, null, 2));
    
    const { id, name, user_ids, property_type, providers, interval, enabled } = req.body;
    
    if (!id || !name || !providers || !Array.isArray(providers)) {
      console.error('[External API] Missing required fields');
      return res.send({ error: 'Missing required fields: id, name, providers' }, 400);
    }
    
    // Ensure external_api user exists (required for foreign key constraint)
    const externalApiUser = getUser('external_api');
    if (!externalApiUser) {
      console.log('[External API] Creating external_api user...');
      upsertUser({
        userId: 'external_api',
        username: 'external_api',
        password: 'external_api_' + Date.now(), // Random password (not used for login)
        isAdmin: false
      });
    }
    
    console.log('[External API] Checking if job already exists...');
    const existingJob = getJob(id);
    
    if (existingJob) {
      console.log(`[External API] Job ${id} already exists, updating it`);
      // Update existing job
      upsertJob({
        jobId: id,
        name,
        enabled: enabled !== undefined ? enabled : true,
        provider: providers,
        notificationAdapter: [
          {
            id: 'telegram',
            fields: {
              token: '${BOT_TOKEN}',
              chatId: '${RAW_FEED_CHANNEL_ID}'
            }
          }
        ],
        userId: 'external_api', // Default user for external API jobs
        shareWithUsers: user_ids || []
      });
      
      console.log('[External API] Job updated successfully in database');
      
      res.send({ 
        message: 'Job updated successfully', 
        job: { id, name, enabled, property_type, providers, user_ids } 
      }, 200);
    } else {
      console.log('[External API] Creating new job in database...');
      
      // Create new job in database
      upsertJob({
        jobId: id,
        name,
        enabled: enabled !== undefined ? enabled : true,
        provider: providers,
        notificationAdapter: [
          {
            id: 'telegram',
            fields: {
              token: '${BOT_TOKEN}',
              chatId: '${RAW_FEED_CHANNEL_ID}'
            }
          }
        ],
        userId: 'external_api', // Default user for external API jobs
        shareWithUsers: user_ids || []
      });
      
      console.log('[External API] Job created successfully in database');
      
      res.send({ 
        message: 'Job created successfully', 
        job: { id, name, enabled, property_type, providers, user_ids } 
      }, 201);
    }
  } catch (error) {
    console.error('[External API] Error creating job:', error);
    console.error('[External API] Error stack:', error.stack);
    res.send({ error: 'Failed to create job', details: error.message }, 500);
  }
});

/**
 * PATCH /external/jobs/:id - Update job (user_ids)
 */
router.patch('/jobs/:id', async (req, res) => {
  try {
    console.log('[External API] Received PATCH /api/external/jobs/:id');
    console.log('[External API] Job ID:', req.params.id);
    console.log('[External API] Request body:', JSON.stringify(req.body, null, 2));
    
    const { id } = req.params;
    const { user_ids, enabled } = req.body;
    
    const existingJob = getJob(id);
    
    if (!existingJob) {
      console.error('[External API] Job not found:', id);
      return res.send({ error: 'Job not found' }, 404);
    }
    
    // Update job in database
    upsertJob({
      jobId: id,
      name: existingJob.name,
      enabled: enabled !== undefined ? enabled : existingJob.enabled,
      provider: existingJob.provider,
      notificationAdapter: existingJob.notificationAdapter,
      userId: existingJob.userId,
      shareWithUsers: user_ids !== undefined ? user_ids : existingJob.shareWithUsers || []
    });
    
    console.log('[External API] Job updated successfully in database');
    
    res.send({ 
      message: 'Job updated successfully', 
      job: { id, user_ids, enabled } 
    });
  } catch (error) {
    console.error('[External API] Error updating job:', error);
    console.error('[External API] Error stack:', error.stack);
    res.send({ error: 'Failed to update job', details: error.message }, 500);
  }
});

/**
 * DELETE /external/jobs/:id - Delete job
 */
router.delete('/jobs/:id', async (req, res) => {
  try {
    console.log('[External API] Received DELETE /api/external/jobs/:id');
    console.log('[External API] Job ID:', req.params.id);
    
    const { id } = req.params;
    
    const existingJob = getJob(id);
    
    if (!existingJob) {
      console.error('[External API] Job not found:', id);
      return res.send({ error: 'Job not found' }, 404);
    }
    
    // Delete job from database
    removeJob(id);
    
    console.log('[External API] Job deleted successfully from database');
    
    res.send({ 
      message: 'Job deleted successfully', 
      deleted_job: { id } 
    });
  } catch (error) {
    console.error('[External API] Error deleting job:', error);
    console.error('[External API] Error stack:', error.stack);
    res.send({ error: 'Failed to delete job', details: error.message }, 500);
  }
});

export { router as fredyJobRouter };

