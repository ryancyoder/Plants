import type { NextConfig } from "next";

// Nothing to configure. The app is the plant catalog, the Supabase client and a
// password gate -- no native packages to keep out of the bundle, which is most
// of what the configuration it was extracted from existed to say.
const nextConfig: NextConfig = {};

export default nextConfig;
