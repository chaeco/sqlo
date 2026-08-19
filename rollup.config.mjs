import typescript from '@rollup/plugin-typescript'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import dts from 'rollup-plugin-dts'

// node:sqlite and other Node built-ins are resolved at runtime.
const external = [/^node:/]

const config = [
  // ESM bundle — single file. Previous layout was dist/src/*; consumers import
  // via "." only, so a single dist/index.js is equivalent and simpler.
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.js',
      format: 'es',
      sourcemap: true,
    },
    plugins: [
      nodeResolve({ extensions: ['.ts', '.js'] }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.build.json' }),
    ],
    external,
  },
  // Async worker entry — must stay a separate file; AsyncSqlo spawns it via
  // `new Worker(resolve(__dirname, 'async-worker.js'))`.
  {
    input: 'src/async/async-worker.ts',
    output: {
      file: 'dist/async-worker.js',
      format: 'es',
      sourcemap: true,
    },
    plugins: [
      nodeResolve({ extensions: ['.ts', '.js'] }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.build.json' }),
    ],
    external,
  },
  // Type declarations — single bundled .d.ts
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    plugins: [dts({ tsconfig: './tsconfig.build.json', respectExternal: true })],
    external,
  },
]

export default config
