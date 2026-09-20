import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'
import { entryListProblem } from '../src/discovery.ts'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/**
 * Exactly the keys `BasicCompactionConfig` accepts. Typing the record with
 * `Record<keyof BasicCompactionConfig, true>` makes this list compile-fail the
 * moment the plugin gains or renames a configuration field, so the preset rows
 * cannot silently drift from the configuration they read.
 */
const ACCEPTED_CONFIG_KEYS: Record<keyof BasicCompactionConfig, true> = {
  thresholdRatio: true,
  retainRatio: true,
  retainTokens: true,
  summarizationProvider: true,
  summarizationModel: true,
  maxTokens: true,
  compactionRetries: true,
  maxOverflowRetries: true,
  modelPolicies: true,
  auto: true,
}

const PRESETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets')

const COMPACTING_PRESETS = ['standard', 'cordis', 'ptc'] as const

/** One row of a shipped composition file. */
interface CompositionRow {
  id?: unknown
  name?: unknown
  config?: unknown
}

/**
 * Read one shipped composition with the loader's own YAML dialect and shape
 * rule, so the rows this test inspects are the rows a mount would accept.
 * @param preset - shipped preset directory name.
 * @returns the parsed row list.
 */
async function composition(preset: string): Promise<CompositionRow[]> {
  const file = join(PRESETS, preset, 'agent.cordis.yml')
  const rows = load(await readFile(file, 'utf8'), { schema: entryListSchema }) as CompositionRow[]
  expect(entryListProblem(rows), `${preset}/agent.cordis.yml must be mountable`).toBeUndefined()
  return rows
}

/**
 * Read the `compaction-basic` row of one shipped preset.
 * @param preset - shipped preset directory name.
 * @returns the row that mounts `dsh-compaction-basic`.
 */
async function compactionRow(preset: string): Promise<CompositionRow> {
  const rows = await composition(preset)
  const group = rows.find(row => row.id === 'compaction')
  expect(group, `${preset} must mount the compaction group`).toBeDefined()
  const nested = group?.config as CompositionRow[]
  const row = nested.find(candidate => candidate.id === 'compaction-basic')
  expect(row, `${preset} must mount compaction-basic`).toBeDefined()
  return row as CompositionRow
}

describe('shipped compaction presets pin their summarization route', () => {
  it.each(COMPACTING_PRESETS)('%s', async (preset) => {
    const row = await compactionRow(preset)
    expect(row.name).toBe('@deepseek-ai/dsh-compaction-basic')
    expect(row.config).toMatchObject({
      summarizationProvider: 'deepseek-official',
      summarizationModel: 'deepseek-flash',
    })
  })

  it.each(COMPACTING_PRESETS)('%s configures only accepted keys', async (preset) => {
    const config = (await compactionRow(preset)).config as Record<string, unknown>
    for (const key of Object.keys(config)) {
      expect(Object.hasOwn(ACCEPTED_CONFIG_KEYS, key), `unknown compaction config key ${key}`).toBe(true)
    }
  })

  it('leaves the minimal preset without a compaction policy', async () => {
    const rows = await composition('minimal')
    expect(rows.some(row => row.id === 'compaction')).toBe(false)
  })

  it('keeps the DeepSeek route reachable for every deployment', async () => {
    // The pin names a route the base bundle always registers; a shipped preset
    // that named a route no bundle mounts would fail only at the first summary.
    const base = await readFile(
      join(PRESETS, '..', '..', '..', 'bundle', 'base', 'cordis.patch.yml'),
      'utf8',
    )
    expect(base).toContain("name: '@deepseek-ai/dsh-llm-deepseek'")
  })
})
