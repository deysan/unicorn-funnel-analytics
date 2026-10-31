import { it } from 'vitest';
import { verifyFileIsolation } from './helpers/isolated-d1';

it('файл B має окреме сховище D1', async () => {
  await verifyFileIsolation('file-b');
});
