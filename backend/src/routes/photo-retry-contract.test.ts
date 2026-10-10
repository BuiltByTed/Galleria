import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '../../..');
const frontendHandler = fs.readFileSync(
  path.join(
    projectRoot,
    'frontend/src/components/AdminPortal/AlbumsManager/handlers/photoHandlers.ts'
  ),
  'utf8'
);
const server = fs.readFileSync(path.join(projectRoot, 'backend/src/server.ts'), 'utf8');

const contracts = [
  {
    name: 'image optimization retry',
    frontendPath: '/api/image-optimization/retry-photo',
    routerFile: 'image-optimization.ts',
    mount: 'app.use("/api/image-optimization", imageOptimizationRouter);'
  },
  {
    name: 'AI title retry',
    frontendPath: '/api/ai-titles/retry-photo',
    routerFile: 'ai-titles.ts',
    mount: 'app.use("/api/ai-titles", aiTitlesRouter);'
  }
];

for (const contract of contracts) {
  test(`${contract.name} frontend path is registered by the backend`, () => {
    const router = fs.readFileSync(path.join(testDir, contract.routerFile), 'utf8');

    assert.ok(
      frontendHandler.includes(`\${API_URL}${contract.frontendPath}`),
      `frontend must POST to ${contract.frontendPath}`
    );
    assert.match(
      router,
      /router\.post\(['"]\/retry-photo['"]/,
      `${contract.routerFile} must register POST /retry-photo`
    );
    assert.ok(
      server.includes(contract.mount),
      `server must mount ${contract.routerFile} at ${path.dirname(contract.frontendPath)}`
    );
  });
}
