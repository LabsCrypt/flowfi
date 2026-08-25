import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Regression test for issue #801.
 *
 * After removing the legacy SorobanIndexerService, only SorobanEventWorker
 * must be started during the server boot sequence. This test verifies:
 *
 * 1. The soroban-indexer.service module no longer exists.
 * 2. index.ts does not import or call sorobanIndexerService.
 * 3. Only startWorkers (which starts SorobanEventWorker) is called at boot.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Single indexer regression (#801)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('soroban-indexer.service.ts should no longer exist', async () => {
    const filePath = path.resolve(
      __dirname,
      '../src/services/soroban-indexer.service.ts',
    );
    let exists = false;
    try {
      await import('fs').then((fs) => {
        fs.accessSync(filePath);
        exists = true;
      });
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('index.ts should not reference sorobanIndexerService', async () => {
    const fs = await import('fs');
    const indexPath = path.resolve(__dirname, '../src/index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).not.toContain('sorobanIndexerService');
    expect(content).not.toContain('soroban-indexer.service');
  });

  it('index.ts should only call startWorkers (not sorobanIndexerService.start)', async () => {
    const fs = await import('fs');
    const indexPath = path.resolve(__dirname, '../src/index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('await startWorkers()');
    expect(content).not.toMatch(/sorobanIndexerService\.start\(\)/);
  });

  it('workers/index.ts only starts SorobanEventWorker (no other indexer)', async () => {
    const fs = await import('fs');
    const workersIndexPath = path.resolve(__dirname, '../src/workers/index.ts');
    const content = fs.readFileSync(workersIndexPath, 'utf-8');
    expect(content).toContain('sorobanEventWorker.start()');
    expect(content).not.toContain('sorobanIndexerService');
  });
});
