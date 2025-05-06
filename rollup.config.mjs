import typescript from 'rollup-plugin-typescript2';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'src/main.ts',
  output: {
    dir: 'dist',
    sourcemap: 'inline',
    format: 'cjs',
  },
  external: [
    'obsidian',
    'fs',
    'path',
    'os',
    'node-fetch',
  ],
  plugins: [
    nodeResolve({ browser: true }),
    typescript(),
  ],
}; 