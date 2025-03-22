#!/usr/bin/env node

import { program } from 'commander';
import fs from 'node:fs/promises';
import { vectorizeFile, ColorMode, Hierarchical, PathSimplifyMode } from './vectorizer.js';

// Set up command line interface
program
  .name('high-quality-vectorizer')
  .description('Convert raster images to high-quality SVG vector graphics')
  .argument('<input>', 'Input image file path')
  .argument('[output]', 'Output SVG file path (defaults to input path with .svg extension)')
  .option('--filter-speckle <pixels>', 'Filter speckles smaller than X pixels (default: 2)', parseInt, 2)
  .option('--color-precision <bits>', 'Color precision in bits (default: 8)', parseInt, 8)
  .option('--layer-difference <value>', 'Color difference between layers (default: 2)', parseFloat, 2)
  .option('--corner-threshold <degrees>', 'Corner threshold in degrees (default: 80)', parseFloat, 80)
  .option('--length-threshold <value>', 'Length threshold (default: 1.0)', parseFloat, 1.0)
  .option('--max-iterations <count>', 'Maximum iterations (default: 50)', parseInt, 50)
  .option('--splice-threshold <degrees>', 'Splice threshold in degrees (default: 3)', parseFloat, 3)
  .option('--path-precision <decimals>', 'Path precision decimal places (default: 3)', parseInt, 3)
  .option('--no-optimize', 'Disable SVG optimization (not recommended)')
  .option('--no-short-hex', 'Disable short hex color conversion');

async function main() {
  try {
    program.parse();

    const [inputPath, outputPath] = program.args;
    const options = program.opts();

    // Validate input file
    try {
      await fs.access(inputPath);
    } catch {
      console.error(`Error: Input file '${inputPath}' does not exist`);
      process.exit(1);
    }

    console.log(`Reading input file: ${inputPath}`);
    console.log('Starting vectorization with high-quality settings...');
    console.log('This may take some time for complex images...');
    
    // Call the library function
    const { svg, stats, outputPath: finalOutputPath } = await vectorizeFile(inputPath, outputPath, options);
    
    // Report results
    console.log(`SVG generation complete in ${stats.vectorizeTime.toFixed(2)} ms`);
    
    if (stats.optimizeTime > 0) {
      console.log(`SVG optimization complete in ${stats.optimizeTime.toFixed(2)} ms`);
      
      const originalKb = (stats.originalSize / 1024).toFixed(2);
      const finalKb = (stats.finalSize / 1024).toFixed(2);
      
      console.log(`File size: ${originalKb} KB → ${finalKb} KB (${stats.sizeReduction.toFixed(2)}% reduction)`);
    }
    
    console.log(`Successfully wrote SVG to: ${finalOutputPath}`);
    console.log(`Total processing time: ${(stats.vectorizeTime + stats.optimizeTime).toFixed(2)} ms`);
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();