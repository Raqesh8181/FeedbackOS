CREATE TABLE IF NOT EXISTS feedback (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_id VARCHAR(255) NULL,
  customer_name VARCHAR(255) NULL,
  message TEXT NOT NULL,
  sentiment ENUM('positive','neutral','negative') NULL,
  category VARCHAR(100) NULL,
  severity ENUM('low','medium','high','critical') NULL,
  summary TEXT NULL,
  embedding JSON NULL,
  problem_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_feedback_created_at (created_at),
  INDEX idx_feedback_problem_id (problem_id)
);

CREATE TABLE IF NOT EXISTS problems (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  impact TEXT NULL,
  category VARCHAR(100) NULL,
  recommended_team VARCHAR(150) NULL,
  priority ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  severity ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  status ENUM('detected','prioritized','assigned','acknowledged','investigating','action_taken','monitoring','resolved') NOT NULL DEFAULT 'detected',
  owner VARCHAR(150) NULL,
  first_detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  feedback_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_problems_status (status),
  INDEX idx_problems_priority (priority)
);

CREATE TABLE IF NOT EXISTS problem_feedback (
  problem_id BIGINT UNSIGNED NOT NULL,
  feedback_id BIGINT UNSIGNED NOT NULL,
  similarity_score DECIMAL(8,6) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (problem_id, feedback_id),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS actions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  problem_id BIGINT UNSIGNED NOT NULL,
  owner VARCHAR(150) NULL,
  description TEXT NOT NULL,
  status ENUM('open','in_progress','completed') NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS problem_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  problem_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NULL,
  detail TEXT NULL,
  metadata JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_problem_events_problem (problem_id, created_at),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  problem_id BIGINT UNSIGNED NOT NULL,
  date DATE NOT NULL,
  feedback_count INT NOT NULL DEFAULT 0,
  negative_count INT NOT NULL DEFAULT 0,
  positive_count INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_problem_date (problem_id, date),
  FOREIGN KEY (problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
