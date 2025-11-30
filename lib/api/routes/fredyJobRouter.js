/**
 * Fredy Job Management API Router
 * External API for programmatic job management (for MyImmoBuddy integration)
 */

import restana from 'restana';
import fs from 'fs/promises';
import path from 'path';
import { getDirName } from '../../utils.js';

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
    
    console.log('[External API] Loading config...');
    const config = await loadConfig();
    const jobs = config.jobs || [];
    
    if (jobs.find(j => j.id === id)) {
      console.log(`[External API] Job ${id} already exists`);
      return res.send({ error: 'Job with this ID already exists' }, 409);
    }
    
    const newJob = {
      id,
      name,
      enabled: enabled !== undefined ? enabled : true,
      interval: interval || 180,
      user_ids: user_ids || [],
      property_type: property_type || 'APARTMENT',
      provider: providers,
      notificationAdapter: [
        {
          id: 'telegram',
          fields: {
            token: '${BOT_TOKEN}',
            chatId: '${RAW_FEED_CHANNEL_ID}'
          }
        }
      ]
    };
    
    console.log('[External API] Adding job to config:', newJob.id);
    jobs.push(newJob);
    config.jobs = jobs;
    
    console.log('[External API] Saving config...');
    await saveConfig(config);
    console.log('[External API] Config saved successfully');
    
    res.send({ 
      message: 'Job created successfully', 
      job: newJob 
    }, 201);
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
    const { id } = req.params;
    const { user_ids, enabled } = req.body;
    
    const config = await loadConfig();
    const jobs = config.jobs || [];
    
    const jobIndex = jobs.findIndex(j => j.id === id);
    
    if (jobIndex === -1) {
      return res.send({ error: 'Job not found' }, 404);
    }
    
    if (user_ids !== undefined) {
      jobs[jobIndex].user_ids = user_ids;
    }
    if (enabled !== undefined) {
      jobs[jobIndex].enabled = enabled;
    }
    
    config.jobs = jobs;
    await saveConfig(config);
    
    res.send({ 
      message: 'Job updated successfully', 
      job: jobs[jobIndex] 
    });
  } catch (error) {
    console.error('Error updating job:', error);
    res.send({ error: 'Failed to update job' }, 500);
  }
});

/**
 * DELETE /external/jobs/:id - Delete job
 */
router.delete('/jobs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const config = await loadConfig();
    const jobs = config.jobs || [];
    
    const jobIndex = jobs.findIndex(j => j.id === id);
    
    if (jobIndex === -1) {
      return res.send({ error: 'Job not found' }, 404);
    }
    
    const deletedJob = jobs.splice(jobIndex, 1)[0];
    config.jobs = jobs;
    
    await saveConfig(config);
    
    res.send({ 
      message: 'Job deleted successfully', 
      deleted_job: deletedJob 
    });
  } catch (error) {
    console.error('Error deleting job:', error);
    res.send({ error: 'Failed to delete job' }, 500);
  }
});

export { router as fredyJobRouter };

