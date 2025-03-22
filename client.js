/**
 * Vectorizer MCP Client
 * Simple client to send canvas screenshots and console logs to the MCP server
 * Must be explicitly initialized to avoid performance impact on games
 */

// Configuration with defaults
const DEFAULT_CONFIG = {
  serverUrl: 'ws://localhost:8869',  // Using WebSocket protocol to avoid CORS issues
  captureDelay: 1000, // Minimum delay between captures in ms
  maxLogs: 10,        // Maximum number of logs to store
  maxErrors: 10,      // Maximum number of errors to store
  autoConnect: false, // Don't connect automatically
  autoCapture: false  // Don't start capturing automatically
};

class VectorizerClient {
  constructor(config = {}) {
    // Merge default config with user config
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize state
    this.socket = null;
    this.canvas = null;
    this.console_logs = [];
    this.console_errors = [];
    this.unhandled_exception = null;
    this.isConnected = false;
    this.isCapturing = false;
    this.captureTimeout = null;
    this.initialized = false;
    
    // Set up console proxies (always do this to collect logs)
    this.setupConsoleProxy();
    
    // Set up global error handling
    this.setupGlobalErrorHandling();
    
    // Check if we should auto-initialize
    if (this.config.autoConnect) {
      // Initialize on DOM ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.initialize());
      } else {
        this.initialize();
      }
    }
  }
  
  /**
   * Initialize the client - must be called explicitly unless autoConnect is true
   * @returns {VectorizerClient} The client instance for chaining
   */
  initialize() {
    if (this.initialized) {
      console.log('[Vectorizer] Client already initialized');
      return this;
    }
    
    console.log('[Vectorizer] Initializing client');
    this.initialized = true;
    
    // Find canvas element
    this.findCanvas();
    
    // Connect to server
    this.connectToServer();
    
    return this;
  }
  
  /**
   * Find the canvas element
   */
  findCanvas() {
    // Try to find by ID first
    this.canvas = document.getElementById('game-canvas');
    
    // Fall back to query selector for any canvas
    if (!this.canvas) {
      const canvases = document.querySelectorAll('canvas');
      if (canvases.length > 0) {
        this.canvas = canvases[0];
      }
    }
    
    if (this.canvas) {
      console.log('[Vectorizer] Found canvas:', this.canvas);
    } else {
      console.warn('[Vectorizer] No canvas element found, will retry later');
    }
  }
  
  /**
   * Connect to the vectorizer server
   */
  connectToServer() {
    if (!window.io) {
      console.error('[Vectorizer] Socket.IO not found. Include socket.io client script in your HTML.');
      return;
    }
    
    try {
      console.log(`[Vectorizer] Connecting to server: ${this.config.serverUrl}`);
      
      // Use websocket transport only to further avoid CORS issues
      this.socket = window.io(this.config.serverUrl, {
        transports: ['websocket'],
        upgrade: false
      });
      
      this.socket.on('connect', () => {
        this.isConnected = true;
        console.log('[Vectorizer] Connected to server');
        
        // Start capture loop after connection, but only if autoCapture is enabled
        if (this.config.autoCapture) {
          this.startCaptureLoop();
        } else {
          console.log('[Vectorizer] Connected but not auto-capturing. Call startCaptureLoop() to begin capturing.');
        }
      });
      
      this.socket.on('disconnect', () => {
        this.isConnected = false;
        console.log('[Vectorizer] Disconnected from server');
        
        // Stop capture loop on disconnect
        this.stopCaptureLoop();
      });
      
      this.socket.on('error', (error) => {
        console.error('[Vectorizer] Socket error:', error);
      });
    } catch (error) {
      console.error('[Vectorizer] Failed to connect:', error);
    }
  }
  
  /**
   * Set up console proxy to capture logs
   */
  setupConsoleProxy() {
    // Store original console methods with proper binding
    const originalLog = console.log.bind(console);
    const originalError = console.error.bind(console);
    
    // Store reference to this for closure
    const self = this;
    
    // Override console.log
    console.log = function(...args) {
      // Call original method
      originalLog(...args);
      
      // Add to our log queue
      self.console_logs.push({
        timestamp: Date.now(),
        data: args
      });
      
      // Keep queue at configured length
      while (self.console_logs.length > self.config.maxLogs) {
        self.console_logs.shift();
      }
    };
    
    // Override console.error
    console.error = function(...args) {
      // Call original method
      originalError(...args);
      
      // Add to our error queue
      self.console_errors.push({
        timestamp: Date.now(),
        data: args
      });
      
      // Keep queue at configured length
      while (self.console_errors.length > self.config.maxErrors) {
        self.console_errors.shift();
      }
    };
  }
  
  /**
   * Set up global error handling to catch unhandled exceptions
   */
  setupGlobalErrorHandling() {
    const self = this;
    
    // Capture unhandled exceptions
    window.addEventListener('error', function(event) {
      const error = event.error || new Error(event.message);
      const stack = error.stack || 'No stack trace available';
      
      // Store the error with timestamp
      self.unhandled_exception = {
        timestamp: Date.now(),
        message: error.message || 'Unknown error',
        stack: stack,
        source: event.filename || 'Unknown source',
        line: event.lineno,
        column: event.colno,
        type: error.name || 'Error'
      };
      
      // Also log to console for visibility
      console.error('[Vibe-Eyes] Unhandled exception captured:', self.unhandled_exception);
    });
    
    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', function(event) {
      const error = event.reason || new Error('Unhandled Promise rejection');
      const stack = error.stack || 'No stack trace available';
      
      // Store the error with timestamp
      self.unhandled_exception = {
        timestamp: Date.now(),
        message: error.message || 'Unhandled Promise rejection',
        stack: stack,
        type: 'UnhandledPromiseRejection',
        reason: event.reason
      };
      
      // Also log to console for visibility
      console.error('[Vibe-Eyes] Unhandled promise rejection captured:', self.unhandled_exception);
    });
  }
  
  /**
   * Start the capture loop
   */
  startCaptureLoop() {
    if (this.isCapturing) return;
    
    this.isCapturing = true;
    this.captureAndSend();
  }
  
  /**
   * Stop the capture loop
   */
  stopCaptureLoop() {
    this.isCapturing = false;
    
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
      this.captureTimeout = null;
    }
  }
  
  /**
   * Capture and send data to the server
   */
  captureAndSend() {
    // Only proceed if connected and capturing is enabled
    if (!this.isConnected || !this.isCapturing) {
      return;
    }
    
    // Make sure we have a canvas
    if (!this.canvas) {
      this.findCanvas();
      
      if (!this.canvas) {
        console.warn('[Vectorizer] No canvas found, retrying in 1 second');
        this.captureTimeout = setTimeout(() => this.captureAndSend(), 1000);
        return;
      }
    }
    
    try {
      // Get canvas data URL
      const dataUrl = this.canvas.toDataURL('image/png');
      
      // Prepare message
      const message = {
        timestamp: Date.now(),
        image: dataUrl,
        console_logs: [...this.console_logs],
        console_errors: [...this.console_errors],
        unhandled_exception: this.unhandled_exception
      };
      
      // Send to server and wait for acknowledgment
      this.socket.emit('debugCapture', message, (response) => {
        // Schedule next capture after server acknowledges receipt
        this.captureTimeout = setTimeout(
          () => this.captureAndSend(),
          this.config.captureDelay
        );
      });
    } catch (error) {
      console.error('[Vectorizer] Error capturing canvas:', error);
      
      // Retry after delay even if there was an error
      this.captureTimeout = setTimeout(
        () => this.captureAndSend(),
        this.config.captureDelay
      );
    }
  }
}

// Create global variable but don't auto-initialize
window.vectorizerClient = new VectorizerClient();

/**
 * Initialize the vectorizer client with optional configuration
 * @param {Object} config - Configuration options
 * @returns {VectorizerClient} The initialized client instance
 */
export function initializeVectorizer(config = {}) {
  // If already initialized, just update config
  if (window.vectorizerClient.initialized) {
    console.log('[Vectorizer] Already initialized, updating config');
    window.vectorizerClient.config = { ...window.vectorizerClient.config, ...config };
    return window.vectorizerClient;
  }
  
  // Create or reinitialize with new config
  window.vectorizerClient = new VectorizerClient(config);
  window.vectorizerClient.initialize();
  
  return window.vectorizerClient;
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { 
    VectorizerClient,
    initializeVectorizer
  };
}

// Export for ES modules
export { VectorizerClient };