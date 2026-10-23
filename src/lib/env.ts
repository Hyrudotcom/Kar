/** Build-time configuration (EXPO_PUBLIC_* are inlined by Metro). */
export const env = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
  googleAndroidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
  googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
  demoMode: process.env.EXPO_PUBLIC_DEMO_MODE ?? '',
};

export const isSupabaseConfigured = (): boolean => env.supabaseUrl.length > 0 && env.supabaseAnonKey.length > 0;

/** Device builds use the in-memory demo only when explicitly requested. */
export const isDemoModeRequested = (): boolean => env.demoMode === '1';
