export interface WAAProfile {
  PageURL: string
  Locale: "en-US"
  TimeZone: "UTC"
  Window: Record<string, unknown>
  Navigator: Record<string, unknown>
  Screen: Record<string, unknown>
  Document: Record<string, unknown>
  LocalStorage: Record<string, string>
  HasFocus: boolean
}

export function realmProfile(
  profile: WAAProfile,
  kind: "top" | "frame",
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    hasFocus: profile.HasFocus,
    localStorage: profile.LocalStorage,
    window:
      kind === "top" ?
        profile.Window
      : Object.fromEntries(
          [
            "outerWidth",
            "outerHeight",
            "screenX",
            "screenY",
            "screenLeft",
            "screenTop",
            "devicePixelRatio",
            "mozInnerScreenX",
          ]
            .filter((k) => k in profile.Window)
            .map((k) => [k, profile.Window[k]]),
        ),
    values: {
      navigator: profile.Navigator,
      screen: profile.Screen,
      document:
        kind === "top" ? profile.Document : { cookie: profile.Document.cookie },
    },
  }
  if (kind === "top") {
    const url = new URL(profile.PageURL)
    result.location = Object.fromEntries(
      [
        "href",
        "origin",
        "protocol",
        "host",
        "hostname",
        "port",
        "pathname",
        "search",
        "hash",
      ].map((k) => [k, url[k as keyof URL]]),
    )
  }
  return result
}

export function createProfile(cookie: string): WAAProfile {
  return {
    PageURL:
      "https://aistudio.google.com/prompts/new_chat?model=gemini-flash-latest&temporary=true",
    Locale: "en-US",
    TimeZone: "UTC",
    HasFocus: true,
    LocalStorage: {},
    Document: { cookie },
    Window: {
      innerHeight: 945,
      innerWidth: 1680,
      outerHeight: 1002,
      outerWidth: 1680,
      screenX: 0,
      screenY: 0,
    },
    Navigator: {
      appCodeName: "Mozilla",
      appName: "Netscape",
      appVersion: "5.0 (Windows)",
      doNotTrack: "unspecified",
      globalPrivacyControl: false,
      hardwareConcurrency: 16,
      language: "en-US",
      languages: ["en-US", "en"],
      oscpu: "Windows NT 10.0; Win64; x64",
      platform: "Win32",
      product: "Gecko",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
    },
    Screen: {
      availHeight: 1002,
      availWidth: 1680,
      colorDepth: 24,
      height: 1050,
      pixelDepth: 24,
      width: 1680,
    },
  }
}
