#!/usr/bin/env node

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { vectorizeImage } from './vectorizer.js';
import crypto from 'crypto';

// Create Express app
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 50 * 1024 * 1024 // 50MB max message size
});

let mcpRequestCount = 0;
let mcpRequestWithoutSvgCount = 0;

// Configuration
const PORT = process.env.PORT || 8869;
const USE_STDIO = process.argv.includes('--stdio');

// Store only the latest processed capture
let latestCapture = null;

// SSE connections: Map<sessionId, { res }>
const sseConnections = new Map();

// Extract and process image from data URL
async function processDataUrl(dataUrl) {
  try {
    const matches = dataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
    
    if (!matches) {
      throw new Error('Invalid data URL format');
    }
    
    const imageType = matches[1];
    const base64Data = matches[2];
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    const result = await vectorizeImage(imageBuffer, {
      filterSpeckle: 4,
      maxIterations: 30
    });
    
    return {
      imageType,
      svg: result.svg,
      stats: result.stats
    };
  } catch (error) {
    console.error('Error processing data URL:', error);
    return { error: error.message };
  }
}

// Middleware for parsing JSON bodies
app.use(express.json({ limit: '100mb' }));

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ============================================
// MCP Protocol Handler
// ============================================

const MCP_TOOLS = [
  {
    name: 'getGameDebugInfoWithLogsAndVisualization',
    description: `Get the latest game state including console logs and an SVG visualization of the canvas.
    
Note: Debug visualization uses SVG vectorization as approximation which may smooth sharp edges and simplify geometric shapes.
The actual canvas rendering may have more precise angles and edges than shown here.
This provides a single frame at a time and is not suitable for viewing animations.`,
    inputSchema: {
      type: 'object',
      properties: {
        includeSvg: {
          type: 'boolean',
          description: 'Whether to include the SVG visualization (default: true). Set to false for faster responses when you only need logs.',
          default: true
        }
      },
      required: []
    }
  }
];

class MCPHandler {
  constructor() {
    this.initialized = false;
  }

  async handleRequest(request) {
    const { id, method, params } = request;

    try {
      let result;

      switch (method) {
        case 'initialize':
          result = this.handleInitialize(params);
          break;
        case 'notifications/initialized':
          return null;
        case 'tools/list':
          result = this.handleToolsList();
          break;
        case 'tools/call':
          result = await this.handleToolCall(params);
          break;
        case 'ping':
          result = {};
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      if (id !== undefined) {
        return { jsonrpc: '2.0', id, result };
      }
      return null;
    } catch (err) {
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err.message }
        };
      }
      return null;
    }
  }

  handleInitialize(params) {
    this.initialized = true;
    console.error('MCP Initialize:', params?.clientInfo?.name || 'unknown client');
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'vibe-eyes',
        version: '1.0.0'
      }
    };
  }

  handleToolsList() {
    return { tools: MCP_TOOLS };
  }

  async handleToolCall(params) {
    const { name, arguments: args } = params;

    if (name !== 'getGameDebugInfoWithLogsAndVisualization') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      };
    }

    const includeSvg = args?.includeSvg !== false;
    
    mcpRequestCount++;
    if (!includeSvg) {
      mcpRequestWithoutSvgCount++;
    }

    if (!latestCapture) {
      return {
        content: [{
          type: 'text',
          text: 'No game data available yet. Make sure a game client is connected and sending captures.'
        }]
      };
    }

    const capture = latestCapture;

    // Extract console logs for easier viewing
    const consoleLogs = capture.console_logs.map(log => ({
      time: new Date(log.timestamp).toISOString(),
      message: log.data.join(' ')
    }));

    // Extract errors if any
    const errors = capture.console_errors.map(err => ({
      time: new Date(err.timestamp).toISOString(),
      message: err.data.join(' ')
    }));

    // Format the data
    let textContent = `
Game State: ${capture.id} (${new Date(capture.timestamp).toISOString()})

Console Logs:
${consoleLogs.map(log => `[${log.time}] ${log.message}`).join('\n') || '(none)'}

${errors.length ? 'Errors:\n' + errors.map(err => `[${err.time}] ${err.message}`).join('\n') : 'No errors.'}
${capture.unhandled_exception ? `\nUnhandled Exception:\n${JSON.stringify(capture.unhandled_exception, null, 2)}` : ''}
`;

    // Add SVG if requested and available
    if (includeSvg && capture.vectorized?.svg) {
      textContent += `\nSVG Approximation:\n\`\`\`svg\n${capture.vectorized.svg}\n\`\`\``;
    }

    return {
      content: [{ type: 'text', text: textContent }]
    };
  }
}

const mcpHandler = new MCPHandler();

// ============================================
// SSE Endpoint for MCP (Claude Code compatible)
// ============================================

app.get('/sse', (req, res) => {
  const sessionId = crypto.randomUUID();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Store the connection
  sseConnections.set(sessionId, { res });

  // Send the endpoint event telling client where to POST messages
  res.write(`event: endpoint\ndata: http://localhost:${PORT}/message?sessionId=${sessionId}\n\n`);

  console.error(`SSE client connected (session: ${sessionId.slice(0, 8)}...)`);

  // Handle client disconnect
  req.on('close', () => {
    sseConnections.delete(sessionId);
    console.error(`SSE client disconnected (session: ${sessionId.slice(0, 8)}...)`);
  });
});

// SSE message endpoint - client POSTs JSON-RPC requests here
app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const connection = sseConnections.get(sessionId);

  if (!connection) {
    return res.status(400).json({ error: 'Invalid or expired session' });
  }

  try {
    const request = req.body;
    const response = await mcpHandler.handleRequest(request);

    // Send response via SSE
    if (response) {
      connection.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    }

    // Acknowledge the POST
    res.status(202).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// HTTP Endpoints
// ============================================

// Health check / status
app.get('/', (req, res) => {
  const accept = req.headers.accept || '';
  
  // If client wants SSE, redirect to /sse
  if (accept.includes('text/event-stream')) {
    return res.redirect('/sse');
  }
  
  res.json({
    status: 'ok',
    hasCapture: !!latestCapture,
    captureTimestamp: latestCapture?.timestamp,
    sseClients: sseConnections.size,
    mcpRequestCount,
    mcpRequestWithoutSvgCount
  });
});

// Serve the most recent capture
app.get('/latest', (req, res) => {
  if (latestCapture) {
    res.json(latestCapture);
  } else {
    res.status(404).json({ error: 'No captures available yet' });
  }
});

// Direct MCP POST endpoint (for simple HTTP clients)
app.post('/mcp', async (req, res) => {
  try {
    const response = await mcpHandler.handleRequest(req.body);
    if (response) {
      res.json(response);
    } else {
      res.status(202).end();
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// Socket.IO - Game Client Connections
// ============================================

io.on('connection', (socket) => {
  console.error('Game client connected:', socket.id);

  // Inform client about latest capture status
  if (latestCapture) {
    socket.emit('captureStatus', {
      hasCapture: true,
      timestamp: latestCapture.timestamp
    });
  }

  // Handle debug captures
  socket.on('debugCapture', async (data, callback) => {
    try {
      const capture = {
        id: `capture_${Date.now()}`,
        timestamp: data.timestamp || Date.now(),
        console_logs: data.console_logs || [],
        console_errors: data.console_errors || [],
        unhandled_exception: data.unhandled_exception || null
      };

      // Process image if provided
      if (data.image) {
        const processingStart = Date.now();
        try {
          const imageResult = await processDataUrl(data.image);
          if (!imageResult.error) {
            capture.vectorized = {
              svg: imageResult.svg,
              imageType: imageResult.imageType,
              stats: imageResult.stats
            };
          } else {
            console.error('Image processing failed:', imageResult.error);
          }
        } catch (imageError) {
          console.error('Image processing exception:', imageError);
        }
      }

      // Store as latest capture
      latestCapture = capture;

      if (callback) {
        callback({
          success: true,
          id: capture.id,
          processedAt: Date.now(),
          svg: capture.vectorized?.svg || null,
          stats: capture.vectorized?.stats || null,
          mcpRequestCount,
          mcpRequestWithoutSvgCount
        });
      }
    } catch (error) {
      console.error('Error processing debug capture:', error);
      if (callback) {
        callback({ error: error.message, success: false });
      }
    }
  });

  // Handle request for latest capture
  socket.on('getLatestCapture', (callback) => {
    if (latestCapture) {
      callback({
        success: true,
        capture: latestCapture,
        svg: latestCapture.vectorized?.svg || null,
        stats: latestCapture.vectorized?.stats || null
      });
    } else {
      callback({ success: false, error: 'No captures available yet' });
    }
  });

  socket.on('disconnect', () => {
    console.error('Game client disconnected:', socket.id);
  });
});

// ============================================
// Startup
// ============================================

httpServer.listen(PORT, () => {
  console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Vibe-Eyes MCP Server v1.0.0
  HTTP + SSE + Socket.IO on port ${PORT}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MCP Endpoints:
  SSE:    http://localhost:${PORT}/sse
  POST:   http://localhost:${PORT}/mcp

Game Client:
  Socket.IO: http://localhost:${PORT}/

Waiting for game clients to connect...
`);
});

// Optional: stdio transport for backwards compatibility
if (USE_STDIO) {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (line.trim()) {
      try {
        const request = JSON.parse(line);
        const response = await mcpHandler.handleRequest(request);
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch (err) {
        console.error('Error parsing stdin:', err.message);
      }
    }
  });

  console.error('stdio MCP transport enabled (--stdio flag)');
}
