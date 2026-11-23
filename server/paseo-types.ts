import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type HostPaseoApi = PluginHandlerContext["paseo"];
export type HostAgent = Awaited<ReturnType<HostPaseoApi["agents"]["list"]>>["entries"][number]["agent"];
export type HostProviderSnapshotResult = Awaited<ReturnType<HostPaseoApi["providers"]["snapshot"]>>;
export type HostProviderControlsInput = Parameters<HostPaseoApi["providers"]["listControls"]>[0];
