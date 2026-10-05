import { useEffect, useState } from 'react'
import { AppProvider } from './state/AppState'
import { Categories } from './pages/Categories'
import { Dashboard } from './pages/Dashboard'
import { Upload } from './pages/Upload'

function useHashRoute(): string {
  const get = () => (window.location.hash.replace(/^#/, '').split('?')[0] || '/')
  const [route, setRoute] = useState(get)
  useEffect(() => {
    const on = () => setRoute(get())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

function Routes() {
  const route = useHashRoute()
  if (route === '/upload') return <Upload />
  if (route === '/categories') return <Categories />
  return <Dashboard />
}

export function App() {
  return (
    <AppProvider>
      <Routes />
    </AppProvider>
  )
}
