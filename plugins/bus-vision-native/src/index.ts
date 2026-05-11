import { registerPlugin } from '@capacitor/core';

import type { BusVisionNativePlugin } from './definitions';

const BusVisionNative = registerPlugin<BusVisionNativePlugin>('BusVisionNative', {
  web: () => import('./web').then((m) => new m.BusVisionNativeWeb()),
});

export * from './definitions';
export { BusVisionNative };
