import { WebPlugin } from '@capacitor/core';

import type { BusVisionNativePlugin } from './definitions';

export class BusVisionNativeWeb extends WebPlugin implements BusVisionNativePlugin {
  async echo(options: { value: string }): Promise<{ value: string }> {
    console.log('ECHO', options);
    return options;
  }
}
