#!/usr/bin/env node

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { vectorizeImage } from './vectorizer.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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

// Store only the latest processed capture
let latestCapture = null; // Initialize as null and set with real data when available

// Create a test capture for initial state (only used if no real capture comes in)
const createTestCapture = () => ({
  id: "capture_test_" + Date.now(),
  timestamp: Date.now(),
  console_logs: [
    { timestamp: Date.now() - 1000, data: ["Player position:", {x: 10, y: 20}] },
    { timestamp: Date.now(), data: ["Game started"] }
  ],
  console_errors: [],
  unhandled_exception: null,
  vectorized: {
    svg: "<svg width='100' height='100'><circle cx='50' cy='50' r='40' fill='blue'/></svg>",
    imageType: "png",
    stats: { processingTime: 100 }
  }
});


// Extract and process image from data URL
async function processDataUrl(dataUrl) {
  try {
    // Extract the base64 part from the data URL
    const matches = dataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
    
    if (!matches) {
      throw new Error('Invalid data URL format');
    }
    
    const imageType = matches[1];
    const base64Data = matches[2];
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Process the image with vectorizer
    const result = await vectorizeImage(imageBuffer, {
      // Configure for faster processing since this is for debugging
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


// Serve the most recent capture
app.get('/latest', (req, res) => {
  if (latestCapture) {
    res.json(latestCapture);
  } else {
    res.status(404).json({ error: 'No captures available yet' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
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
      // console.log(`[${new Date().toISOString()}] Processing new debug capture...`);
      
      // Create capture object
      const capture = {
        id: `capture_${Date.now()}`,
        timestamp: data.timestamp || Date.now(),
        console_logs: data.console_logs || [],
        console_errors: data.console_errors || [],
        unhandled_exception: data.unhandled_exception || null
      };
      
      // Process image if provided - this is async and we need to await it
      if (data.image) {
        // console.log(`[${new Date().toISOString()}] Processing image...`);
        const processingStart = Date.now();
        
        try {
          // Await image processing to complete before sending ack
          const imageResult = await processDataUrl(data.image);
          
          if (!imageResult.error) {
            // Store the vectorized data
            capture.vectorized = {
              svg: imageResult.svg,
              imageType: imageResult.imageType,
              stats: imageResult.stats
            };
            // console.log(`[${new Date().toISOString()}] Image processed in ${Date.now() - processingStart}ms`);
          } else {
            console.error(`[${new Date().toISOString()}] Image processing failed:`, imageResult.error);
          }
        } catch (imageError) {
          console.error(`[${new Date().toISOString()}] Image processing exception:`, imageError);
        }
      }
      
      
      // Store as latest capture (replacing previous)
      latestCapture = capture;
      
      // Log receipt
      // console.log(`[${new Date().toISOString()}] Capture complete: ${capture.id}`);
      
      // Only send callback AFTER all processing is done
      if (callback) {
        callback({
          success: true,
          id: capture.id,
          processedAt: Date.now(),
          // Include the SVG in the response to client
          svg: capture.vectorized ? capture.vectorized.svg : null,
          stats: capture.vectorized ? capture.vectorized.stats : null,
          mcpRequestCount,
          mcpRequestWithoutSvgCount,
        });
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing debug capture:`, error);
      if (callback) {
        callback({ 
          error: error.message,
          success: false
        });
      }
    }
  });
  
  // Handle request for latest capture
  socket.on('getLatestCapture', (callback) => {
    if (latestCapture) {
      callback({ 
        success: true,
        capture: latestCapture,
        // Include the SVG directly for easy access
        svg: latestCapture.vectorized ? latestCapture.vectorized.svg : null,
        stats: latestCapture.vectorized ? latestCapture.vectorized.stats : null
      });
    } else {
      callback({ 
        success: false,
        error: 'No captures available yet' 
      });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Create the MCP server with description from README
const mcpServer = new McpServer({
  name: "Vibe-Eyes",
  version: "1.0.0",
  description: `An MCP server that enables LLMs to 'see' what's happening in browser-based games and applications through vectorized canvas approximation and debug information.
  Note: Debug visualization uses SVG vectorization as approximation which may smooth sharp edges and simplify geometric shapes.
  The actual canvas rendering may have more precise angles and edges than shown here.
  Also, the vectorization process is optimized for speed and may not be suitable for high-fidelity graphics.
  This server provides a way to visualize game states and debug information in a structured format, but it is a single frame at a time and not particularly useful for viewing animations.`,
});

// MCP tool with includeSvg parameter
mcpServer.tool("getGameDebugInfoWithLogsAndVisualization", {
  includeSvg: z.boolean().optional().default(true)
}, async ({ includeSvg }) => {
  mcpRequestCount++;
  if (!includeSvg) {
    mcpRequestWithoutSvgCount++;
  }
  // Simply use the latest capture
  if (!latestCapture) {
    // Return basic response when no data is available
    return {
      success: false,
      content: [{
        type: "text",
        text: "No game data available yet."
      }]
    };
  }
  
  // Use the capture directly
  const capture = latestCapture;
  
  // Remove SVG if not explicitly requested
  if (!includeSvg && capture.vectorized) {
    delete capture.vectorized.svg;
  }
  
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
  
  // Format the data for better MCP display
  // Create a text representation of the game state
  const textContent = `
Game State: ${capture.id} (${new Date(capture.timestamp).toISOString()})

Console Logs:
${consoleLogs.map(log => `[${log.time}] ${log.message}`).join('\n')}

${errors.length ? 'Errors:\n' + errors.map(err => `[${err.time}] ${err.message}`).join('\n') : 'No errors.'}
${capture.unhandled_exception ? `\nUnhandled Exception:\n${JSON.stringify(capture.unhandled_exception, null, 2)}` : ''}

`;

  // Return in MCP-compatible format
  // Prepare result object
  const result = {
    success: true,
    content: [
      {
        type: "text",
        text: textContent
      }
    ]
  };
  
  // Only add SVG if we have it and it was requested
  if (capture.vectorized?.svg && includeSvg) {
    try {
      // Add SVG as text directly in the response
      result.content[0].text += "\nSVG Approximation:\n```svg\n" + capture.vectorized.svg + "\n```";
    } catch (error) {
      console.error("Error with SVG data:", error);
      // Add error note to text content
      result.content[0].text += "\n\nError processing SVG data";
    }
  }
  
  return result;
});

// Initialize both HTTP and MCP servers
(async () => {
  // Start HTTP server
  httpServer.listen(PORT, () => {
    console.log(`MCP Vectorizer debug server running on port ${PORT}`);
  });
  
  // Start MCP server
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.log('MCP Protocol server started');
})();
