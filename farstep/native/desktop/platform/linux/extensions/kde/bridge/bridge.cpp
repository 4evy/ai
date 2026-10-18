#include "bridge.h"

#include <QDBusConnection>
#include <QDBusError>
#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDBusServiceWatcher>
#include <QDebug>
#include <QFile>
#include <QRegularExpression>
#include <cerrno>
#include <sys/stat.h>
#include <wayland_server.h>
#include <window.h>
#include <workspace.h>

Bridge::Bridge(QObject *parent) : QObject(parent) {
  if (!KWin::waylandServer() || !KWin::Workspace::self())
    return;
  // This signal precedes initial desktop assignment and activation
  connect(KWin::waylandServer(), &KWin::WaylandServer::windowCreated, this,
          [this](KWin::Window *window) { Q_EMIT windowCreated(window); });
  connect(KWin::Workspace::self(), &KWin::Workspace::windowAdded, this,
          [this](KWin::Window *window) { Q_EMIT windowMapped(window); });
  auto bus = QDBusConnection::sessionBus();
  if (!bus.registerObject("/org/farstep/Compositor", this,
                          QDBusConnection::ExportScriptableSlots))
    return;
  m_available = true;
  auto *watcher =
      new QDBusServiceWatcher("org.farstep.Workspaces", bus,
                              QDBusServiceWatcher::WatchForOwnerChange, this);
  connect(watcher, &QDBusServiceWatcher::serviceOwnerChanged, this,
          [this](const QString &, const QString &oldOwner,
                 const QString &newOwner) {
            m_ownerKnown = true;
            m_owner = newOwner;
            if (!oldOwner.isEmpty()) {
              for (const auto &id : m_leases)
                stop(id);
              Q_EMIT ownerLost();
            }
          });
  // Cache the unique owner without blocking KWin on each broker request
  auto query = QDBusMessage::createMethodCall(
      "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      "GetNameOwner");
  query.setArguments({QString("org.farstep.Workspaces")});
  auto *pending = new QDBusPendingCallWatcher(bus.asyncCall(query, 5000), this);
  connect(pending, &QDBusPendingCallWatcher::finished, this, [this, pending] {
    const QDBusPendingReply<QString> reply = *pending;
    // An owner-change signal supersedes the initial lookup
    if (!m_ownerKnown && !reply.isError()) {
      m_owner = reply.value();
      m_ownerKnown = true;
    }
    pending->deleteLater();
  });
}

Bridge::~Bridge() {
  for (const auto &id : m_leases)
    stop(id);
  if (m_available)
    QDBusConnection::sessionBus().unregisterObject("/org/farstep/Compositor");
}

static QString cgroupPath(int pid) {
  QFile file(QString("/proc/%1/cgroup").arg(pid));
  if (pid <= 0 || !file.open(QIODevice::ReadOnly))
    return {};
  for (const auto &line : file.readAll().split('\n'))
    if (line.startsWith("0::"))
      return QString::fromUtf8(line.mid(3));
  return {};
}

QString Bridge::scope(int pid) const {
  for (const auto &component : cgroupPath(pid).split('/'))
    if (component.startsWith("omp-gui-") && component.endsWith(".scope"))
      return component;
  return {};
}

bool Bridge::attach(const QString &id, int pid) {
  if (!m_leases.contains(id))
    return false;
  const auto path = cgroupPath(pid);
  const auto unit = QString("omp-gui-%1.scope").arg(id);
  QString root;
  // Observe the whole scope even if the launch process is in a child cgroup
  for (const auto &component : path.split('/')) {
    if (component.isEmpty())
      continue;
    root += '/';
    root += component;
    if (component == unit) {
      m_cgroups.insert(id, root);
      return populated(id);
    }
  }
  return false;
}

bool Bridge::populated(const QString &id) const {
  const auto path = m_cgroups.value(id);
  if (path.isEmpty())
    return false;
  const auto directory = "/sys/fs/cgroup" + path;
  QFile file(directory + "/cgroup.events");
  if (!file.open(QIODevice::ReadOnly)) {
    // Only a removed scope establishes emptiness after a read failure
    struct stat metadata{};
    return ::stat(QFile::encodeName(directory).constData(), &metadata) == 0 ||
           errno != ENOENT;
  }
  const auto events = file.readAll();
  if (file.error() != QFileDevice::NoError)
    return true;
  bool empty = false;
  for (const auto &line : events.split('\n')) {
    if (line == "populated 1")
      return true;
    if (line == "populated 0")
      empty = true;
  }
  return !empty;
}

void Bridge::retain(const QString &id) {
  static const QRegularExpression uuid(
      "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
  if (uuid.match(id).hasMatch())
    m_leases.insert(id);
}

void Bridge::forget(const QString &id) {
  m_leases.remove(id);
  m_cgroups.remove(id);
}

void Bridge::stop(const QString &id) {
  if (!m_leases.contains(id))
    return;
  auto call = QDBusMessage::createMethodCall(
      "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager", "KillUnit");
  call.setArguments({QString("omp-gui-%1.scope").arg(id), QString("all"), 9});
  // KWin must keep rendering while systemd processes emergency stops
  auto *pending = new QDBusPendingCallWatcher(
      QDBusConnection::sessionBus().asyncCall(call, 5000), this);
  connect(pending, &QDBusPendingCallWatcher::finished, this, [pending] {
    const QDBusPendingReply<> reply = *pending;
    if (reply.isError() &&
        reply.error().name() != "org.freedesktop.systemd1.NoSuchUnit" &&
        reply.error().name() != "org.freedesktop.systemd1.UnitNotLoaded")
      qWarning() << "Farstep could not stop a workspace scope:"
                 << reply.error();
    pending->deleteLater();
  });
}

QString Bridge::Call(const QString &operation, const QString &payload) {
  if (!calledFromDBus())
    return {};
  if (m_owner.isEmpty() || message().service() != m_owner) {
    sendErrorReply(QDBusError::AccessDenied,
                   "Only the workspace broker may call the compositor");
    return {};
  }
  auto result = m_handler.call({operation, payload});
  if (result.isError() || !result.isString()) {
    sendErrorReply(QDBusError::Failed, result.toString());
    return {};
  }
  return result.toString();
}
