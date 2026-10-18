import QtQuick
import org.kde.kwin
import "@BRIDGE@" as Native
import "../code/main.js" as Logic

Item {
    property var router
    Native.Bridge {
        id: bridge
    }
    Component.onCompleted: router = Logic.FarstepKWin.createRouter(Workspace, bridge)
    Component.onDestruction: if (router)
        router.shutdown()
}
