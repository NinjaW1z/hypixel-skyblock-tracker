import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';

/**
 * Build a Hypixel-shaped item_bytes blob from plain values. Used by the test-suite and the
 * mock API server; the live pipeline only ever decodes.
 */
export interface ItemSpec {
  id: string;
  name?: string;
  count?: number;
  rarity?: string;
  lore?: string[];
  extra?: Record<string, unknown>;
}

function toTag(v: unknown): unknown {
  if (typeof v === 'string') return nbt.string(v);
  if (typeof v === 'boolean') return nbt.byte(v ? 1 : 0);
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? nbt.int(v) : nbt.double(v);
  if (typeof v === 'bigint') return nbt.long(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return nbt.list(nbt.string([]));
    const first = toTag(v[0]) as { type: string };
    const items = v.map((x) => (toTag(x) as { value: unknown }).value);
    return { type: 'list', value: { type: first.type, value: items } };
  }
  if (v && typeof v === 'object') return compound(v as Record<string, unknown>);
  return nbt.string(String(v));
}
function compound(obj: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toTag(v);
  return nbt.comp(out);
}

export function encodeItemBytes(spec: ItemSpec): string {
  const lore = spec.lore ?? [`§7Some lore`, `§6§l${spec.rarity ?? 'COMMON'}`];
  const root = nbt.comp(
    {
      i: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            (compound({
              id: 'minecraft:stone',
              Count: spec.count ?? 1,
              Damage: 0,
              tag: {
                display: { Name: spec.name ?? spec.id, Lore: lore },
                ExtraAttributes: { id: spec.id, ...(spec.extra ?? {}) },
              },
            }) as { value: unknown }).value,
          ],
        },
      },
    },
    '',
  ) as nbt.NBT;
  const buf = nbt.writeUncompressed(root, 'big');
  return gzipSync(buf).toString('base64');
}
