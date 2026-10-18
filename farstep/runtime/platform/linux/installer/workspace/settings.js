const settings = new imports.gi.Gio.Settings({ schema_id: "org.gnome.shell" });
const uuid = ARGV[0];
const previous = settings.get_strv("enabled-extensions");
const enabled =
  ARGV[1] === "enable"
    ? previous.includes(uuid)
      ? previous
      : [...previous, uuid]
    : previous.filter((value) => value !== uuid);
if (
  JSON.stringify(previous) !== JSON.stringify(enabled) &&
  !settings.set_strv("enabled-extensions", enabled)
)
  throw new Error("GNOME extension settings are locked");
const previousDisabled = settings.get_strv("disabled-extensions");
const disabled = previousDisabled.filter((value) => value !== uuid);
if (
  JSON.stringify(previousDisabled) !== JSON.stringify(disabled) &&
  !settings.set_strv("disabled-extensions", disabled)
)
  throw new Error("GNOME disabled extension settings are locked");
