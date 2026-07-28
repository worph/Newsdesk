import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api'
import { Layout } from './components/Layout'
import { Config } from './pages/Config'
import { Ideas } from './pages/Ideas'
import { Inbox } from './pages/Inbox'
import { Login } from './pages/Login'

export function App() {
  const queryClient = useQueryClient()
  const { data, isPending } = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })

  if (isPending) return <div className="p-6 text-sm text-desk-500">Loading…</div>

  if (!data?.authenticated) {
    return (
      <Routes>
        <Route
          path="*"
          element={<Login onSignedIn={() => queryClient.invalidateQueries({ queryKey: ['me'] })} />}
        />
      </Routes>
    )
  }

  return (
    <Layout>
      <Routes>
        <Route path="/config" element={<Config />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/ideas" element={<Ideas />} />
        <Route path="*" element={<Navigate to="/inbox" replace />} />
      </Routes>
    </Layout>
  )
}
