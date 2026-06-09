import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
    },
    format: ['cjs', 'esm'],
    platform: 'node',
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    // The 4 satellites + the heavy PDF runtimes resolve from the consumer's
    // node_modules — never bundle them into dist (keeps native binaries like
    // @jogi/cedula's sharp out of the consumer's webpack graph).
    external: ['@jogi/doctypes', '@jogi/classifier', '@jogi/extract', '@jogi/cedula', 'pdf-lib', 'pdfjs-dist'],
    treeshake: true,
})
