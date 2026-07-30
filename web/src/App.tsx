import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api'
import { Layout } from './components/Layout'
import { Config } from './pages/Config'
import { Ideas } from './pages/Ideas'
import { Inbox } from './pages/Inbox'
import { Login } from './pages/Login'
import { Queue } from './pages/Queue'
import { Review } from './pages/Review'
import { Settings } from './pages/Settings'
import { Stories } from './pages/Stories'
import { Story } from './pages/Story'

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
        <Route path="/queue" element={<Queue />} />
        <Route path="/stories" element={<Stories />} />
        <Route path="/stories/:id" element={<Story />} />
        <Route path="/review/:id" element={<Review />} />
        <Route path="/config" element={<Config />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/ideas" element={<Ideas />} />
        <Route path="*" element={<Navigate to="/queue" replace />} />
      </Routes>
    </Layout>
  )
}
