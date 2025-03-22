import fs from 'node:fs/promises';
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';
import { optimize } from 'svgo';

/**
 * Helper function to round hex color components to make them shorthand-compatible
 * @param {string} hexPair - Two-character hex value (e.g., "FF", "A7")
 * @returns {string} Rounded hex pair that can be represented in shorthand
 */
function roundHexComponent(hexPair) {
  // Convert hex to decimal (0-255)
  const dec = parseInt(hexPair, 16);
  
  // Round to nearest value that can be represented in short hex
  // 0, 51, 102, 153, 204, 255 correspond to 0, 3, 6, 9, C, F
  if (dec < 26) return '00';        // 0
  if (dec < 77) return '33';        // 3
  if (dec < 128) return '66';       // 6
  if (dec < 179) return '99';       // 9
  if (dec < 230) return 'CC';       // C
  return 'FF';                      // F
}

/**
 * Round all hex colors in an SVG to make them convertible to shorthand format
 * @param {string} svg - Original SVG content
 * @returns {string} SVG with rounded hex colors
 */
function roundHexColors(svg) {
  // Regular expression to find all 6-digit hex colors
  const hexColorRegex = /#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})\b/gi;
  
  // Replace with rounded versions that have matching pairs
  return svg.replace(hexColorRegex, (match, r, g, b) => {
    const roundedR = roundHexComponent(r);
    const roundedG = roundHexComponent(g);
    const roundedB = roundHexComponent(b);
    
    return `#${roundedR}${roundedG}${roundedB}`;
  });
}

/**
 * Get SVGO configuration for maximum optimization
 * @param {boolean} [shortHex=true] - Whether to use short hex colors
 * @returns {Object} SVGO configuration object
 */
function getSvgoConfig(shortHex = true) {
  const config = {
    multipass: true,
    js2svg: {
      pretty: false,
      indent: 0,
      useShortTags: true  // Use self-closing tags
    },
    plugins: [
      // Just use preset-default with some options we know work well
      {
        name: 'preset-default',
        params: {
          overrides: {
            // Basic optimizations that work
            inlineStyles: true,
            cleanupNumericValues: {
              floatPrecision: 0
            },
            convertPathData: {
              floatPrecision: 0,
              transformPrecision: 0,
              noSpaceAfterFlags: true,
              leadingZero: false,
              negativeExtraSpace: true
            },
            removeViewBox: false,
            collapseGroups: true,
            mergePaths: true,
            // Force attributes to be written without spaces
            cleanupListOfValues: {
              floatPrecision: 0,
              leadingZero: false
            }
          }
        }
      },
      // Remove XML overhead
      {
        name: 'removeXMLProcInst',
        active: true
      },
      {
        name: 'removeComments',
        active: true
      },
      // Simplify paths
      {
        name: 'removeUselessStrokeAndFill',
        active: true
      }
    ]
  };
  
  // Conditionally add the color plugin
  if (shortHex) {
    config.plugins.push({
      name: 'convertColors',
      active: true,
      params: {
        shorthex: true,
        shortname: true
      }
    });
  }
  
  return config;
}

/**
 * Main vectorization function
 * @param {Buffer|Uint8Array} inputBuffer - Image data buffer
 * @param {Object} [options={}] - Configuration options
 * @returns {Promise<{svg: string, stats: Object}>} Results with SVG and stats
 */
export async function vectorizeImage(inputBuffer, options = {}) {
  // Apply default settings for maximum quality
  const config = {
    // Use color mode for best quality
    colorMode: ColorMode.Color,
    
    // Stacked mode gives better results for photo-realistic images
    hierarchical: Hierarchical.Stacked,
    
    // Use user-defined or default high-quality settings
    filterSpeckle: options.filterSpeckle ?? 2,
    colorPrecision: options.colorPrecision ?? 8,
    layerDifference: options.layerDifference ?? 2,
    
    // Spline mode gives smoother curves
    mode: PathSimplifyMode.Spline,
    
    cornerThreshold: options.cornerThreshold ?? 80,
    lengthThreshold: options.lengthThreshold ?? 1.0,
    maxIterations: options.maxIterations ?? 50,
    spliceThreshold: options.spliceThreshold ?? 3,
    pathPrecision: options.pathPrecision ?? 3
  };

  // Track stats to return to caller
  const stats = {
    vectorizeTime: 0,
    optimizeTime: 0,
    originalSize: 0,
    finalSize: 0,
    sizeReduction: 0
  };
  
  // Process the image
  const vectorizeStart = performance.now();
  const svg = await vectorize(inputBuffer, config);
  stats.vectorizeTime = performance.now() - vectorizeStart;
  stats.originalSize = svg.length;
  
  // Store original SVG
  let finalSvg = svg;
  
  // Apply optimization unless explicitly disabled
  if (options.optimize !== false) {
    const optimizeStart = performance.now();
    
    try {
      // Pre-process SVG to round hex colors if using short hex
      let processedSvg = svg;
      if (options.shortHex !== false) {
        processedSvg = roundHexColors(svg);
      }
      
      // Get SVGO configuration
      const svgoConfig = getSvgoConfig(options.shortHex !== false);
      
      // Run SVGO with our processed SVG
      const result = optimize(processedSvg, svgoConfig);
      finalSvg = result.data;
      
      stats.optimizeTime = performance.now() - optimizeStart;
    } catch (error) {
      console.error('Error during SVG optimization:', error.message);
      // Fall back to the original SVG if optimization fails
      finalSvg = svg;
    }
  }
  
  // Calculate final stats
  stats.finalSize = finalSvg.length;
  stats.sizeReduction = 100 - (finalSvg.length / svg.length) * 100;
  
  return {
    svg: finalSvg,
    stats
  };
}

/**
 * Process an image file and write the result to an output file
 * @param {string} inputPath - Path to input image file
 * @param {string} [outputPath] - Path to output SVG file (defaults to input with .svg extension)
 * @param {Object} [options={}] - Configuration options
 * @returns {Promise<{svg: string, stats: Object, outputPath: string}>} Results with SVG, stats, and output path
 */
export async function vectorizeFile(inputPath, outputPath, options = {}) {
  // Determine output path if not specified
  const finalOutputPath = outputPath || inputPath.replace(/\.[^.]+$/, '.svg');
  
  // Read input file
  const inputBuffer = await fs.readFile(inputPath);
  
  // Process the image
  const result = await vectorizeImage(inputBuffer, options);
  
  // Write output file
  await fs.writeFile(finalOutputPath, result.svg, 'utf8');
  
  // Return results with output path
  return {
    ...result,
    outputPath: finalOutputPath
  };
}

// Export all necessary pieces for library usage
export { ColorMode, Hierarchical, PathSimplifyMode };