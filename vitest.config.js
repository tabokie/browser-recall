import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
  },
  resolve: {
    alias: {
      // semantic-engine.js imports the vendored browser bundle via
      // import('./vendor/transformers.min.js'). In vitest (Node), redirect
      // to the npm package's Node build which has proper ONNX runtime bindings.
      './vendor/transformers.min.js': path.resolve(__dirname, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'),
    },
  },
});
