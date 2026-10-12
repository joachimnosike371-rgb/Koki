// Wagmi + RainbowKit config for HAMR on Robinhood Chain, with BNB Smart Chain
// available as an additional EVM wallet network. Launch execution remains
// gated to Robinhood Chain until the BNB launchpad contracts are deployed.
import { createConfig, http, defineChain } from "wagmi";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { robinhoodChain, PUBLIC_RPC_ABSOLUTE } from "../robinhood/chain";

export const bnbSmartChain = defineChain({
  id: 56,
  name: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://bsc-dataseed.bnbchain.org"] },
  },
  blockExplorers: {
    default: { name: "BscScan", url: "https://bscscan.com" },
  },
  testnet: false,
});

/** WalletConnect Cloud project id. Free tier is fine. */
const WC_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  // Fallback demo id — Vercel deployment MUST override this or
  // WalletConnect returns 403 on the mobile pairing request.
  "hamr-dev";

export const wagmiConfig = getDefaultConfig({
  appName: "HAMR.fun",
  appDescription:
    "Autonomous memecoin launch agent on Robinhood Chain.",
  appUrl: "https://hamr.fun",
  appIcon: "https://hamr.fun/hamr-logo.jpg",
  projectId: WC_PROJECT_ID,
  // BNB is available in the wallet/network selector. Launch forms still
  // enforce Robinhood Chain because no BNB launchpad contracts are configured.
  chains: [robinhoodChain, bnbSmartChain],
  transports: {
    [robinhoodChain.id]: http(PUBLIC_RPC_ABSOLUTE, {
      batch: { wait: 16, batchSize: 60 },
      retryCount: 5,
      retryDelay: 400,
      timeout: 15_000,
    }),
    [bnbSmartChain.id]: http("https://bsc-dataseed.bnbchain.org", {
      retryCount: 3,
      retryDelay: 500,
      timeout: 15_000,
    }),
  },
  ssr: true,
}) as ReturnType<typeof createConfig>;
