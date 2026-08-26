/**
 * Test configuration. The `@deepseek-ai/*` packages this repo builds against
 * are not yet published at a usable version, so tests resolve them straight
 * from a deepseek-harness checkout cloned next to this repo (tests and
 * tsconfig.typecheck.json reference it by relative path too). Resolution
 * reuses upstream's own tsconfig.base.json `paths` map through the
 * TypeScript resolver, so every package loads from source exactly as
 * upstream's test lane does.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig, type Plugin } from 'vitest/config'

const upstreamRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deepseek-harness')

function upstreamPathsPlugin(): Plugin {
  const configPath = path.join(upstreamRoot, 'tsconfig.base.json')
  if (!existsSync(configPath)) {
    throw new Error(`deepseek-harness checkout not found at ${upstreamRoot}; clone it next to this repo (see CLAUDE.md)`)
  }
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
  if (error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  // files/include overridden so the parse never globs the whole upstream tree.
  const parsed = ts.parseJsonConfigFileContent({ ...config, files: [], include: [] }, ts.sys, upstreamRoot)
  const importer = path.join(upstreamRoot, '__dsh_timeplus_importer__.ts')
  const cache = new Map<string, string | undefined>()
  return {
    name: 'dsh-upstream-paths',
    enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/')) return undefined
      if (!cache.has(source)) {
        const resolved = ts.resolveModuleName(source, importer, parsed.options, ts.sys).resolvedModule
        cache.set(source, resolved?.resolvedFileName)
      }
      return cache.get(source)
    },
  }
}

/** Mirror of upstream's vitest.shared.ts: transform standard decorators before Vite parses. */
function standardDecoratorPlugin(): Plugin {
  const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?', 1)[0] as string
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return undefined
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [upstreamPathsPlugin(), standardDecoratorPlugin()],
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
