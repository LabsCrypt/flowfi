export type BannerVariant = "info" | "warning" | "error" | "success";

export interface BannerConfig {
  id: string;
  enabled: boolean;
  variant: BannerVariant;
  message: string;
  link?: { label: string; href: string };
  dismissible?: boolean;
}

const bannerConfig: BannerConfig = {
  id: process.env.NEXT_PUBLIC_BANNER_ID ?? "banner-v1",
  enabled: process.env.NEXT_PUBLIC_BANNER_ENABLED === "true",
  variant: (process.env.NEXT_PUBLIC_BANNER_VARIANT as BannerVariant) ?? "info",
  message:
    process.env.NEXT_PUBLIC_BANNER_MESSAGE ??
    "FlowFi is currently in beta. Features and APIs may change without notice.",
  link: process.env.NEXT_PUBLIC_BANNER_LINK_HREF
    ? {
        label: process.env.NEXT_PUBLIC_BANNER_LINK_LABEL ?? "Learn more",
        href: process.env.NEXT_PUBLIC_BANNER_LINK_HREF,
      }
    : undefined,
  dismissible: process.env.NEXT_PUBLIC_BANNER_DISMISSIBLE !== "false",
};

export default bannerConfig;
