export interface BusVisionNativePlugin {
  isNativeAvailable(): Promise<{ available: boolean }>

  ensurePermissions(): Promise<{
    ok: boolean
    camera: string
    microphone: string
    mic: string
  }>

  startCamera(): Promise<{ ok: boolean }>
  stopCamera(): Promise<{ ok: boolean }>

  startRecording(options?: {
    sampleRate?: number
    channels?: number
  }): Promise<{ ok: boolean }>

  stopRecording(): Promise<{
    ok: boolean
    path: string
    audioPath?: string
    filename: string
    audioFilename?: string
    mimeType: string
    durationMs?: number
    cameraMeta?: {
      iso?: number
      exposureTimeNs?: number
      device?: string
    }
  }>

  takePhoto(options?: { filename?: string }): Promise<{
    ok: boolean
    path: string
    filename: string
    mimeType: string
    cameraMeta?: {
      device?: string
    }
  }>



  tapToFocus(options: { x: number; y: number }): Promise<{
    ok: boolean
    tapX: number
    tapY: number
    afState: string
    focusDistanceDiopters?: number
    estimatedMeters?: number
    distanceConfidence: 'high' | 'medium' | 'low' | 'unavailable' | string
    timestamp?: number
    warning?: string
  }>


  getDistanceEstimate(options: { x?: number; y?: number; manualTag?: string }): Promise<{
    ok: boolean
    tapX?: number
    tapY?: number
    afState: string
    focusDistanceDiopters?: number
    estimatedMeters?: number
    finalDistanceMeters?: number
    distanceConfidence: 'high' | 'medium' | 'low' | 'unavailable' | string
    distanceSource: 'arcore_depth' | 'focus_distance' | 'manual_label' | 'unavailable' | string
    manualDistanceLabel?: string
    arcore?: { installed: boolean; available: boolean; depthSupported: boolean; status: string }
    pipeline?: string[]
    timestamp?: number
    warning?: string
  }>

  getFocusInfo(): Promise<{
    ok: boolean
    afState: string
    focusDistanceDiopters?: number
    estimatedMeters?: number
    distanceConfidence: 'high' | 'medium' | 'low' | 'unavailable' | string
    focalLengthMm?: number
    minFocusDistanceDiopters?: number
  }>

  setTorch(options: { enabled: boolean }): Promise<{ ok: boolean }>
  setZoom(options: { ratio: number }): Promise<{ ok: boolean }>
}
