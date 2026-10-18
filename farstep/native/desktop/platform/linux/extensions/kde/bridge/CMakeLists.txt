cmake_minimum_required(VERSION 3.22)
project(FarstepBridge LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 23)
find_package(Qt6 6.6 REQUIRED COMPONENTS Core Qml DBus Widgets Quick)
find_package(KWin REQUIRED)
qt_standard_project_setup(REQUIRES 6.6)
set(CMAKE_INSTALL_RPATH "$ORIGIN")
qt_add_qml_module(farstepbridge
  URI Farstep.Bridge
  OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/Farstep/Bridge"
  SOURCES bridge.h bridge.cpp
)
target_link_libraries(farstepbridge PRIVATE Qt6::DBus KWin::kwin)
install(TARGETS farstepbridge farstepbridgeplugin
  LIBRARY DESTINATION share/farstep/kde/contents/ui/bridge)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/Farstep/Bridge/qmldir"
  DESTINATION share/farstep/kde/contents/ui/bridge)
