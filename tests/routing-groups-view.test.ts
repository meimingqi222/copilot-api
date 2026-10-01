import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type { RoutingGroup } from "~/lib/routing-groups"

interface GroupDraft {
  id: string
  name: string
  members: Array<string>
  expose: boolean
  affinity: string
}

interface GroupView {
  form: GroupDraft
  toDraft(group: RoutingGroup): GroupDraft
  buildPayload(): RoutingGroup
}

test("the editor preserves exposure on edit and omits inherited affinity from saved config", () => {
  const source = readFileSync("pages/js/views/routing-groups.js", "utf8")
  const view = runInNewContext(source + "\nroutingGroupsView()", {
    ViewHelpers: {},
  }) as GroupView
  expect(view.form.expose).toBe(false)
  expect(view.form.affinity).toBe("")
  view.form = view.toDraft({
    id: "custom",
    name: "Custom",
    members: ["vendor/model"],
    rules: [],
    expose: true,
  })
  expect(view.buildPayload().expose).toBe(true)
  expect(view.buildPayload().affinity).toBeUndefined()
  view.form.expose = false
  view.form.affinity = "off"
  expect(view.buildPayload()).toMatchObject({ expose: false, affinity: "off" })
})
