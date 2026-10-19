/* Minimal react-native stand-in for jest (no native runtime). */
const React = require('react')

const appStateListeners = new Set()
const AppState = {
  currentState: 'active',
  addEventListener: jest.fn((type, handler) => {
    if (type === 'change') appStateListeners.add(handler)
    return { remove: () => appStateListeners.delete(handler) }
  }),
  /** Test helper: emit an app state change. */
  __emit(next) {
    AppState.currentState = next
    for (const handler of Array.from(appStateListeners)) handler(next)
  },
  __listenerCount: () => appStateListeners.size,
}

const Platform = { OS: 'ios', select: (obj) => (obj.ios !== undefined ? obj.ios : obj.default) }
const StyleSheet = { create: (styles) => styles, flatten: (s) => s }

const host = (name) => {
  const Component = (props) => React.createElement(name, props, props.children)
  Component.displayName = name
  return Component
}

module.exports = {
  AppState,
  Platform,
  StyleSheet,
  View: host('View'),
  Text: host('Text'),
  Pressable: host('Pressable'),
  ActivityIndicator: host('ActivityIndicator'),
}
