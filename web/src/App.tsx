import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api'
import { Layout } from './components/Layout'
import { AdminChat } from './pages/AdminChat'
import { Calendar } from './pages/Calendar'
import { Compose } from './pages/Compose'
import { Config } from './pages/Config'
import { Live } from './pages/Live'
import { Log } from './pages/Log'
import { Login } from './pages/Login'
import { Now } from './pages/Now'
import { Review } from './pages/Review'
import { Settings } from './pages/Settings'
import { Stories } from './pages/Stories'
import { Story } from './pages/Story'
import { Tips } from './pages/Tips'
import { Wire } from './pages/Wire'

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
        {/*
          The front page on a desk. The installed app still opens on /now — its
          start_url is unchanged — because that is the phone arriving from a
          notification, which is a list and not a conversation.
        */}
        <Route path="/" element={<AdminChat />} />
        <Route path="/now" element={<Now />} />
        {/* The Queue was two lists of rows every other screen already owns —
            what needs a decision is /now, the archive behind it is /stories. */}
        <Route path="/queue" element={<Navigate to="/now" replace />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/compose" element={<Compose />} />
        <Route path="/stories" element={<Stories />} />
        <Route path="/stories/:id" element={<Story />} />
        <Route path="/review/:id" element={<Review />} />
        <Route path="/review/:id/live" element={<Live />} />
        <Route path="/config" element={<Config />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/wire" element={<Wire />} />
        <Route path="/log" element={<Log />} />
        <Route path="/tips" element={<Tips />} />
        <Route path="*" element={<Navigate to="/now" replace />} />
      </Routes>
    </Layout>
  )
}
