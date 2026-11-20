export const codeArtsStations = {
  mainland: {
    snap: "https://snap-access.cn-north-4.myhuaweicloud.com",
    gateway: "https://opengw.developer.huaweicloud.com",
    portal: "https://codearts.huaweicloud.com/portal",
    locale: "zh-cn",
  },
  international: {
    snap: "https://snap-access.ap-southeast-1.myhuaweicloud.com",
    gateway: undefined,
    portal: "https://codearts.ap-southeast-1.huaweicloud.com/portal",
    locale: "en-us",
  },
} as const

export type CodeArtsStation = keyof typeof codeArtsStations

export const CODEARTS_IAM = "https://iam.cn-north-4.myhuaweicloud.com"
