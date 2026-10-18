#pragma once

#include <QDBusContext>
#include <QJSValue>
#include <QMap>
#include <QObject>
#include <QSet>
#include <QtQml/qqmlregistration.h>

class Bridge : public QObject, protected QDBusContext {
  Q_OBJECT
  QML_ELEMENT
  Q_CLASSINFO("D-Bus Interface", "org.farstep.Compositor1")
  Q_PROPERTY(QJSValue handler READ handler WRITE setHandler)
  Q_PROPERTY(bool available READ available CONSTANT)

public:
  explicit Bridge(QObject *parent = nullptr);
  ~Bridge() override;
  bool available() const { return m_available; }
  QJSValue handler() const { return m_handler; }
  void setHandler(const QJSValue &handler) { m_handler = handler; }
  Q_INVOKABLE QString scope(int pid) const;
  Q_INVOKABLE bool attach(const QString &id, int pid);
  Q_INVOKABLE bool populated(const QString &id) const;
  Q_INVOKABLE void retain(const QString &id);
  Q_INVOKABLE void forget(const QString &id);
  Q_INVOKABLE void stop(const QString &id);

public Q_SLOTS:
  Q_SCRIPTABLE QString Call(const QString &operation, const QString &payload);

Q_SIGNALS:
  void windowCreated(QObject *window);
  void windowMapped(QObject *window);
  void ownerLost();

private:
  bool m_available = false;
  bool m_ownerKnown = false;
  QString m_owner;
  QJSValue m_handler;
  QSet<QString> m_leases;
  QMap<QString, QString> m_cgroups;
};
