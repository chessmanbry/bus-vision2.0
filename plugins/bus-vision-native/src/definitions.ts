export interface BusVisionNativePlugin {
  echo(options: { value: string }): Promise<{ value: string }>;
}
