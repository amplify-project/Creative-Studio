import path from "path";
import dotenv from "dotenv";
import dotenvExpand from "dotenv-expand";

/** Carga el archivo .env desde otra carpeta */
const myEnv = dotenv.config({
  path: path.resolve("./server/.env.local"),
});
dotenvExpand.expand(myEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_NODE_IP: process.env.NEXT_PUBLIC_NODE_IP,
    NEXT_PUBLIC_LIVEKIT_URL: process.env.NEXT_PUBLIC_LIVEKIT_URL,
  },
  experimental: {
    missingSuspenseWithCSRBailout: false,
  },

  webpackDevMiddleware: (config) => {
    // 👇 Evita que Webpack escuche archivos innecesarios
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/.DS_Store',
        '**/*.log',
        '**/*.pid',
        "**/server/**"
      ],
    };

    console.log("🚫 Ignorando cambios en .git y node_modules");

    return config;
  },
};

export default nextConfig;
