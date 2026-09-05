/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  webpack(config, { isServer }) {
    if (!isServer) {
      // MCP serves one embedded HTML resource without an asset server. Include
      // lazy library modules (Mermaid and ELK) in the initial client bundles.
      config.module.parser = {
        ...config.module.parser,
        javascript: { ...config.module.parser?.javascript, dynamicImportMode: "eager" }
      };
    }
    return config;
  }
};

export default nextConfig;
