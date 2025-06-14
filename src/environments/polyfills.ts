// src/polyfills.ts
import 'zone.js'; // Existing polyfill

// Add these lines:
(window as any).global = window; // If you haven't already added this
(window as any).process = {
  env: { DEBUG: undefined },
  version: '' // Add an empty version or a mock version
};
import { Buffer } from 'buffer';
(window as any).Buffer = Buffer;