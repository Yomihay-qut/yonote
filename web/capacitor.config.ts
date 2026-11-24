import type { CapacitorConfig } from '@capacitor/cli'
const config: CapacitorConfig = {
  appId: 'top.yomihay.yonote',
  appName: '便签',
  webDir: 'dist',
  android: { allowMixedContent: false },
  server: { androidScheme: 'https' },
  plugins: { SystemBars: { initialViewportFitValueHint: 'cover', insetsHandling: 'css' } },
}
export default config
