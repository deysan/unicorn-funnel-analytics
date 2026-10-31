import { it } from 'vitest';
import { verifyFileIsolation } from './helpers/isolated-d1';

it('файл A має окреме сховище D1', async () => {
  await verifyFileIsolation('file-a');
});
