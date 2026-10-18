// Install the packaged API parser profiles into this Ghidra user's settings
// @category Data Types

import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;

public class InstallHeaderProfiles extends GhidraScript {
  @Override
  public void run() throws Exception {
    Path source = Path.of("@profilesDirectory@");
    Path destination = Application.getUserSettingsDirectory().toPath().resolve("parserprofiles");
    Files.createDirectories(destination);
    try (var profiles = Files.list(source)) {
      for (Path profile : profiles.sorted().toList()) {
        monitor.checkCancelled();
        String filename = profile.getFileName().toString();
        if (!filename.endsWith(".prf")) {
          continue;
        }
        byte[] contents = Files.readAllBytes(profile);
        String digest =
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(contents), 0, 6);
        // Each packaged revision gets a distinct name, preserving user edits
        Path target =
            destination.resolve(
                filename.substring(0, filename.length() - 4) + "-" + digest + ".prf");
        if (Files.exists(target)) {
          println("Keeping existing profile: " + target);
        } else {
          Files.write(target, contents);
          println("Installed profile: " + target);
        }
      }
    }
    println("Refresh File > Parse C Source to see the installed profiles");
  }
}
