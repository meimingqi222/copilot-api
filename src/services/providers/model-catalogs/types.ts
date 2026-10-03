export interface CatalogEntry {
  id: string
  name: string
  vendor: string
  supportedEndpoints: Array<string>
  pickerEnabled?: boolean
  upstreamId?: string
}
