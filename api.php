<?php
/**
 * 医学影像浏览器 — PHP 后端(单文件,零扩展依赖,PHP 7.4+ / 8.x)
 * 适用于群晖 Web Station。数据存储在本目录 data/ 下:
 *   data/index.json                       患者-检查-序列索引
 *   data/files/<患者目录>/<检查UID>/<序列UID>/<实例>.dcm
 *   data/tmp/<批次ID>/<文件ID>.dcm         导入暂存(24小时后自动清理)
 *
 * 可选配置: 同目录 config.php 中 define('MV_USER','用户名'); define('MV_PASS','密码');
 *          define('MV_DATA_DIR', '/volume1/...'); 开启访问认证/自定义数据目录。
 */

error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE);
// JSON API 严禁任何警告/通知直接输出污染响应体(错误仍写服务器日志)
@ini_set('display_errors', '0');
define('MV_VERSION', '1.6.2');

$__dir = __DIR__;
if (is_file($__dir . '/config.php')) require_once $__dir . '/config.php';
define('MV_DATA_DIR', defined('MV_DATA_DIR') && MV_DATA_DIR ? MV_DATA_DIR : ($__dir . '/data'));
define('MV_TMP_DIR', MV_DATA_DIR . '/tmp');
define('MV_FILES_DIR', MV_DATA_DIR . '/files');
define('MV_INDEX_FILE', MV_DATA_DIR . '/index.json');
define('MV_GC_HOURS', 24);

header('X-Content-Type-Options: nosniff');

/* ---------------- 工具函数 ---------------- */

function mv_json($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function mv_fail($msg, $code = 400) { mv_json(array('error' => $msg), $code); }
function mv_body_json() {
    $raw = file_get_contents('php://input');
    $j = json_decode($raw, true);
    if (!is_array($j)) mv_fail('请求体不是有效的 JSON');
    return $j;
}
function mv_ensure_dirs() {
    foreach (array(MV_DATA_DIR, MV_TMP_DIR, MV_FILES_DIR) as $d) {
        if (!is_dir($d) && !@mkdir($d, 0770, true)) {
            mv_fail('无法创建数据目录 ' . $d . ',请检查目录写权限(需允许 Web Station 的 http 用户写入)', 500);
        }
    }
    // Apache 下禁止直接访问 data 目录;PHP 经文件系统读取不受影响
    $ht = MV_DATA_DIR . '/.htaccess';
    if (!is_file($ht)) @file_put_contents($ht, "Require all denied\n");
    $idx = MV_DATA_DIR . '/index.html';
    if (!is_file($idx)) @file_put_contents($idx, '');
}
function mv_safe_uid($uid) {
    $uid = trim((string)$uid);
    if ($uid === '') return 'u' . md5(uniqid('', true));
    $s = preg_replace('/[^0-9A-Za-z.\-]/', '_', $uid);
    if ($s !== $uid || strlen($s) < 1) $s = $s . '_' . substr(md5($uid), 0, 6);
    if (strlen($s) > 180) $s = substr($s, 0, 160) . '_' . substr(md5($uid), 0, 8);
    return $s;
}
function mv_mb_substr($s, $len) {
    if (function_exists('mb_substr')) return mb_substr($s, 0, $len, 'UTF-8');
    preg_match('/^.{0,' . (int)$len . '}/us', $s, $m);
    return isset($m[0]) ? $m[0] : $s;
}
function mv_mb_lower($s) {
    if (function_exists('mb_strtolower')) return mb_strtolower($s, 'UTF-8');
    return strtolower($s);
}
function mv_safe_name($s) {
    $s = str_replace(array('\\', '/', ':', '*', '?', '"', '<', '>', '|', "\r", "\n"), '_', (string)$s);
    $s = trim($s);
    return $s === '' ? '未命名' : mv_mb_substr($s, 60);
}
function mv_check_id($x) {
    return is_string($x) && preg_match('/^[A-Za-z0-9._\-]{1,200}$/', $x);
}
function mv_rmrf($p) {
    if (!is_dir($p)) return @unlink($p);
    foreach (scandir($p) as $f) {
        if ($f === '.' || $f === '..') continue;
        mv_rmrf($p . '/' . $f);
    }
    @rmdir($p);
}

/* ---------------- 索引读写(flock 保护) ---------------- */

function mv_index_load() {
    $fp = @fopen(MV_INDEX_FILE, 'c+');
    if (!$fp) mv_fail('无法打开索引文件 ' . MV_INDEX_FILE, 500);
    flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    $idx = json_decode((string)$raw, true);
    if (!is_array($idx) || !isset($idx['patients'])) $idx = array('patients' => array());
    return $idx;
}
function mv_index_save($idx) {
    $tmp = MV_INDEX_FILE . '.tmp';
    if (@file_put_contents($tmp, json_encode($idx, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX) === false) {
        mv_fail('索引写入失败(检查 data 目录权限)', 500);
    }
    @rename($tmp, MV_INDEX_FILE);
}

/* 索引变更排他锁: 防止并发 commit/删除互相覆盖 */
function mv_index_lock() {
    $fp = @fopen(MV_DATA_DIR . '/.index.lock', 'c');
    if (!$fp) mv_fail('无法打开索引锁', 500);
    flock($fp, LOCK_EX);
    return $fp;
}
function mv_index_unlock($fp) {
    if ($fp) { flock($fp, LOCK_UN); fclose($fp); }
}

/* ---------------- 账号与认证 ----------------
 * 账号存于 data/accounts.json; 首次访问自动创建管理员(用户名/密码取 config.php 的 MV_USER/MV_PASS, 默认 admin/admin)。
 * 临时账号由管理员创建, 带 expires 到期时间, 到期即失效。
 */

function mv_accounts_path() { return MV_DATA_DIR . '/accounts.json'; }
function mv_load_accounts() {
    $p = mv_accounts_path();
    if (is_file($p)) {
        $a = json_decode((string)file_get_contents($p), true);
        if (is_array($a) && count($a)) return $a;
    }
    $defUser = (defined('MV_USER') && MV_USER !== '') ? MV_USER : 'admin';
    $defPass = (defined('MV_PASS') && MV_PASS !== '') ? MV_PASS : 'admin';
    $a = array($defUser => array(
        'hash' => password_hash($defPass, PASSWORD_DEFAULT),
        'role' => 'admin', 'expires' => '', 'note' => '管理员', 'created' => date('YmdHis')
    ));
    mv_save_accounts($a);
    return $a;
}
function mv_save_accounts($a) {
    $tmp = mv_accounts_path() . '.tmp';
    @file_put_contents($tmp, json_encode($a, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @rename($tmp, mv_accounts_path());
}
function mv_account_expired($acc) {
    $e = isset($acc['expires']) ? $acc['expires'] : '';
    return $e !== '' && $e !== null && date('YmdHis') > $e;
}
function mv_need_admin() {
    if (($GLOBALS['mv_role'] ?? '') !== 'admin') mv_fail('需要管理员权限', 403);
}
function mv_session_start() {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    @session_set_cookie_params(array('httponly' => true, 'samesite' => 'Lax'));
    session_start();
}

function mv_auth_check() {
    mv_session_start();
    $action = isset($_GET['action']) ? $_GET['action'] : '';
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && $action === 'login') {
        $b = mv_body_json();
        $name = trim((string)($b['user'] ?? ''));
        $accounts = mv_load_accounts();
        if ($name === '' || !isset($accounts[$name]) || !password_verify((string)($b['pass'] ?? ''), $accounts[$name]['hash'])) {
            mv_fail('用户名或密码错误', 401);
        }
        if (mv_account_expired($accounts[$name])) mv_fail('该账号已过期,请联系管理员', 401);
        $_SESSION['mv_user'] = $name;
        $_SESSION['mv_role'] = $accounts[$name]['role'];
        $_SESSION['mv_can_export'] = !empty($accounts[$name]['can_export']) ? 1 : 0;
        $lRole = $accounts[$name]['role'];
        mv_json(array('ok' => true, 'user' => $name, 'role' => $lRole,
            'canExport' => $lRole === 'admin' ? true : !empty($accounts[$name]['can_export'])));
    }
    if (isset($_SESSION['mv_user']) && $_SESSION['mv_user'] !== '') {
        $name = $_SESSION['mv_user'];
        $accounts = mv_load_accounts();
        if (isset($accounts[$name]) && !mv_account_expired($accounts[$name])) {
            $GLOBALS['mv_user'] = $name;
            $GLOBALS['mv_role'] = $accounts[$name]['role'];
            $GLOBALS['mv_can_export'] = !empty($accounts[$name]['can_export']) ? 1 : 0;
            return;
        }
        unset($_SESSION['mv_user'], $_SESSION['mv_role']);
    }
    mv_fail('需要登录', 401);
}

/* ---------------- ZIP 读取(纯 PHP,无扩展依赖) ---------------- */

/** 解压 zip 中所有 DICOM 条目到 $outDir,返回 [{id,name,size}];失败抛异常 */
function mv_zip_extract_dicom($zipPath, $outDir) {
    $fp = @fopen($zipPath, 'rb');
    if (!$fp) throw new Exception('无法读取上传的 ZIP 文件');
    $out = array();
    try {
        $size = filesize($zipPath);
        $scan = min($size, 65557);
        fseek($fp, -$scan, SEEK_END);
        $tail = fread($fp, $scan);
        $pos = strrpos($tail, "PK\x05\x06");
        if ($pos === false) throw new Exception('不是有效的 ZIP 文件');
        $eocd = unpack('vdisk/vcddisk/vtotaldisk/vdtotal/Vcdsize/Vcdoff/vcomment', substr($tail, $pos + 4, 18));
        if ($eocd['cdoff'] == 0xFFFFFFFF || $eocd['cdsize'] == 0xFFFFFFFF) throw new Exception('暂不支持 ZIP64 格式,请重新打包');
        fseek($fp, $eocd['cdoff']);
        $cd = fread($fp, $eocd['cdsize']);
        if (strlen($cd) < 46) throw new Exception('ZIP 目录损坏');
        $p = 0; $n = 0;
        $totalLimit = 20000;
        while ($p + 46 <= strlen($cd) && $n < $totalLimit) {
            if (substr($cd, $p, 4) !== "PK\x01\x02") break;
            $e = unpack('vdmade/vdneed/vflags/vmethod/vtime/vdate/Vcrc/Vcsize/Vusize/vnl/vel/vcl/vdisk/viattr/Veattr/Vlho', substr($cd, $p + 4, 42));
            $name = substr($cd, $p + 46, $e['nl']);
            $p += 46 + $e['nl'] + $e['el'] + $e['cl'];
            if (($e['flags'] & 0x1) && $e['csize'] > 0) throw new Exception('ZIP 文件已加密,无法导入');
            $base = basename($name);
            if (substr($name, -1) === '/' || $base === '' || $base === '.DS_Store'
                || strpos($name, '__MACOSX/') === 0 || stripos($base, 'dicomdir') === 0) continue;
            if ($e['csize'] == 0 && $e['usize'] == 0) continue;

            // 定位本地头数据起点
            fseek($fp, $e['lho']);
            $lh = fread($fp, 30);
            if (strlen($lh) < 30 || substr($lh, 0, 4) !== "PK\x03\x04") continue;
            $lhe = unpack('vnl/vel', substr($lh, 26, 4));
            $dataOff = $e['lho'] + 30 + $lhe['nl'] + $lhe['el'];

            // 流式解压该条目到暂存目录(大文件不载入内存)
            // id 用随机 hex: 同一批次上传多个 ZIP 时顺序 id(0000…)会互相覆盖
            $id = bin2hex(random_bytes(6));
            $outPath = $outDir . '/' . $id . '.dcm';
            $fo = @fopen($outPath, 'wb');
            if (!$fo) continue;
            $ok = false;
            fseek($fp, $dataOff);
            $left = $e['csize'];
            if ($e['method'] == 0) {
                $ok = true;
                while ($left > 0 && !feof($fp)) {
                    $b = fread($fp, min(1048576, $left));
                    if ($b === false || $b === '') { $ok = false; break; }
                    fwrite($fo, $b);
                    $left -= strlen($b);
                }
            } elseif ($e['method'] == 8) {
                $inf = @inflate_init(ZLIB_ENCODING_RAW);
                if ($inf !== false) {
                    $ok = true;
                    while ($left > 0 && !feof($fp)) {
                        $b = fread($fp, min(1048576, $left));
                        if ($b === false || $b === '') { $ok = false; break; }
                        $left -= strlen($b);
                        $d = @inflate_add($inf, $b);
                        if ($d === false) { $ok = false; break; }
                        if ($d !== '') fwrite($fo, $d);
                    }
                    if ($ok) {
                        $d = @inflate_add($inf, '', ZLIB_FINISH);
                        if ($d === false) $ok = false;
                        elseif ($d !== '') fwrite($fo, $d);
                    }
                }
            }
            fclose($fo);
            if (!$ok || filesize($outPath) === 0) { @unlink($outPath); continue; }

            // DICOM 判定: .dcm 扩展名, 或解压后文件偏移128处的 DICM 魔数
            // (必须在解压后的数据上判定 —— 压缩流上读魔数必然失败)
            $isDcmExt = preg_match('/\.dcm$/i', $base);
            if (!$isDcmExt) {
                $ft = @fopen($outPath, 'rb');
                $magic = $ft ? fread($ft, 132) : '';
                if ($ft) fclose($ft);
                if (substr($magic, 128, 4) !== 'DICM'
                    && substr($magic, 0, 4) !== "\x02\x00\x00\x00"      // 无导言的裸数据集(隐式VR文件元)
                    && substr($magic, 4, 2) !== 'UL') {                   // 无导言显式VR文件元
                    @unlink($outPath);
                    continue;
                }
            }
            $out[] = array('id' => $id, 'name' => $base, 'size' => filesize($outPath));
            $n++;
        }
    } finally {
        fclose($fp);
    }
    return $out;
}

/* ---------------- ZIP 流式写入(导出) ---------------- */

function mv_dos_time($ts) {
    if (!$ts) $ts = time();
    $d = getdate($ts);
    $year = max(1980, $d['year']);
    $time = ($d['hours'] << 11) | ($d['minutes'] << 5) | ($d['seconds'] >> 1);
    $date = (($year - 1980) << 9) | ($d['mon'] << 5) | $d['mday'];
    return pack('vv', $time, $date);
}
/** $files: [{path:磁盘路径, name:zip内路径}]; 流式输出 zip 到响应 */
function mv_zip_stream_out($files, $zipName) {
    $zipName = mv_safe_name($zipName) . '.zip';
    // 清空所有输出缓冲(Apache/zlib.output_compression 会破坏流式 zip 与 Content-Disposition)
    while (ob_get_level() > 0) { @ob_end_clean(); }
    if (ini_get('zlib.output_compression')) {
        @ini_set('zlib.output_compression', '0');
    }
    header('Content-Type: application/zip');
    header("Content-Disposition: attachment; filename*=UTF-8''" . rawurlencode($zipName));
    header('Cache-Control: no-store');

    $central = '';
    $offset = 0;
    $count = 0;
    $out = fopen('php://output', 'wb');
    if (!$out) mv_fail('输出流打开失败', 500);

    foreach ($files as $f) {
        if (!is_file($f['path'])) continue;
        $size = filesize($f['path']);
        $h = hash_init('crc32b');
        $fp = fopen($f['path'], 'rb');
        while (!feof($fp)) hash_update($h, fread($fp, 1048576));
        fclose($fp);
        $crcHex = hash_final($h);
        $crcBin = pack('V', hexdec($crcHex));
        $crcVal = unpack('V', $crcBin)[1];

        $name = (string)$f['name']; // UTF-8
        $nl = strlen($name);
        $dt = mv_dos_time(filemtime($f['path']));

        // 本地文件头: 标志 0x0800 = UTF-8 文件名, STORE 方式
        $local = "PK\x03\x04"
            . pack('vvv', 0x0014, 0x0800, 0) . $dt
            . $crcBin . pack('VVvv', $size, $size, $nl, 0)
            . $name;
        fwrite($out, $local);
        $fp = fopen($f['path'], 'rb');
        while (!feof($fp)) { $b = fread($fp, 1048576); if ($b !== '' && $b !== false) fwrite($out, $b); }
        fclose($fp);

        $central .= "PK\x01\x02"
            . pack('vvvv', 0x031E, 0x0014, 0x0800, 0) . $dt
            . $crcBin . pack('VVvv', $size, $size, $nl, 0)
            . pack('vvvVV', 0, 0, 0, 0, $offset)
            . $name;
        $offset += strlen($local) + $size;
        $count++;
    }
    fwrite($out, $central);
    $cdSize = strlen($central);
    fwrite($out, "PK\x05\x06" . pack('vvvvVVv', 0, 0, $count, $count, $cdSize, $offset, 0));
    fclose($out);
    exit;
}

/* ---------------- 层位读取与交织序列拆分 ---------------- */

/** 读 DICOM 头部 ImagePositionPatient(前 24KB 内), 返回 "x,y,z"(厘米级取整) 或 null
 *  字节直搜法: 部分厂商(Philips 等)头部含非常规结构, 顺序遍历会跑偏 */
function mv_read_pos($path) {
    $fp = @fopen($path, 'rb');
    if (!$fp) return null;
    $head = fread($fp, 24576);
    fclose($fp);
    $n = strlen($head);
    if ($n < 200 || substr($head, 128, 4) !== 'DICM') return null;
    $tag = "\x20\x00\x32\x00";   // (0020,0032) 小端
    $off = 132;
    while (true) {
        $p = strpos($head, $tag, $off);
        if ($p === false || $p + 12 > $n) return null;
        $vr = substr($head, $p + 4, 2);
        $ok = ($vr === 'DS') || ($vr === 'IS') || (ctype_upper(substr($vr,0,1)) && ctype_upper(substr($vr,1,1)) && !in_array($vr, array('OB', 'OW', 'SQ', 'UN', 'UT')));
        if (!$ok) { $off = $p + 2; continue; }
        $vl = unpack('v', substr($head, $p + 6, 2))[1];
        if ($vl < 8 || $vl > 60 || $p + 8 + $vl > $n) { $off = $p + 2; continue; }
        $parts = explode(chr(92), rtrim(substr($head, $p + 8, $vl), " " . chr(0)));
        if (count($parts) < 3) { $off = $p + 2; continue; }
        return round(floatval($parts[0]) * 100) . ',' . round(floatval($parts[1]) * 100) . ',' . round(floatval($parts[2]) * 100);
    }
}

function mv_pos_cache($pd, $stSafe, $st) {
    $dir = MV_FILES_DIR . '/' . $pd . '/' . $stSafe;
    $cacheFile = $dir . '/.pos.json';
    $cache = is_file($cacheFile) ? json_decode((string)file_get_contents($cacheFile), true) : null;
    if (!is_array($cache)) $cache = array();
    $dirty = false;
    foreach ($st['series'] as $se) {
        $seUid = $se['uid'];
        if (isset($cache[$seUid]) && count($cache[$seUid]) === count($se['files'])) continue;
        $posList = array();
        foreach ($se['files'] as $f) {
            $posList[] = mv_read_pos($dir . '/' . mv_safe_uid($seUid) . '/' . $f['f'] . '.dcm');
        }
        $cache[$seUid] = $posList;
        $dirty = true;
    }
    if ($dirty) @file_put_contents($cacheFile, json_encode($cache));
    return $cache;
}

/** 把一个序列按层位出现序虚拟拆分; 返回 [子序列...] */
function mv_split_interleaved($se, $filesOut, $posList) {
    if (count($filesOut) < 4 || count($posList) !== count($filesOut)) {
        return array(array('uid' => $se['uid'], 'desc' => $se['desc'], 'files' => $filesOut));
    }
    foreach ($posList as $q) { if ($q === null) return array(array('uid' => $se['uid'], 'desc' => $se['desc'], 'files' => $filesOut)); }
    $seen = array();
    $maxOcc = 1;
    $occ = array();
    foreach ($posList as $i => $q) {
        $c = (isset($seen[$q]) ? $seen[$q] : 0) + 1;
        $seen[$q] = $c;
        $occ[$i] = $c;
        if ($c > $maxOcc) $maxOcc = $c;
    }
    if ($maxOcc < 2) return array(array('uid' => $se['uid'], 'desc' => $se['desc'], 'files' => $filesOut));
    $out = array();
    for ($o = 1; $o <= $maxOcc; $o++) {
        $sub = array();
        foreach ($filesOut as $i => $f) if ($occ[$i] === $o) $sub[] = $f;
        if (!count($sub)) continue;
        $out[] = array('uid' => $se['uid'] . '.s' . $o, 'desc' => $se['desc'] . ' [' . $o . '/' . $maxOcc . ']', 'files' => $sub);
    }
    return $out;
}


/* ---------------- 内部检查主键(sid) ----------------
 * study 的逻辑主键为导入时生成的 sid(目录名=sid), DICOM StudyInstanceUID 仅作属性。
 * 跨患者同 UID 的检查天然互不干扰; 存量数据在此惰性补齐。 */
function mv_migrate_sids(&$idx) {
    $changed = false;
    foreach ($idx['patients'] as &$p) {
        foreach ($p['studies'] as &$st) {
            if (!empty($st['sid'])) continue;
            $st['sid'] = bin2hex(random_bytes(8));
            $st['sdir'] = mv_safe_uid($st['uid']);   // 存量目录名保持 safe(duid)
            $changed = true;
        }
        unset($st);
    }
    unset($p);
    if ($changed) mv_index_save($idx);
}

/* ---------------- 暂存清理 ---------------- */

function mv_gc_tmp() {
    $flag = MV_TMP_DIR . '/.gc';
    if (is_file($flag) && time() - filemtime($flag) < 3600) return;
    @touch($flag);
    if (!is_dir(MV_TMP_DIR)) return;
    foreach (scandir(MV_TMP_DIR) as $d) {
        if ($d === '.' || $d === '..' || $d === '.gc') continue;
        $p = MV_TMP_DIR . '/' . $d;
        $mtime = @filemtime($p);
        if ($mtime && time() - $mtime > MV_GC_HOURS * 3600) mv_rmrf($p);
    }
}

/* ---------------- 患者定位 ---------------- */

function &mv_find_patient(&$idx, $id, $name, $birth) {
    $id = trim((string)$id);
    foreach ($idx['patients'] as &$p) {
        if ($id !== '' && trim((string)$p['id']) === $id) return $p;
    }
    unset($p);
    // 空 ID 时按姓名+生日匹配(两者都缺失时不匹配, 避免把无患者信息的检查错误并入他人)
    if ($id === '' && $name !== '') {
        foreach ($idx['patients'] as &$p) {
            if (trim((string)$p['name']) === $name && trim((string)$p['birth']) === trim((string)$birth)) return $p;
        }
        unset($p);
    }
    $np = array(
        'dir' => bin2hex(random_bytes(6)),
        'id' => $id, 'name' => (string)$name, 'birth' => (string)$birth, 'sex' => '',
        'studies' => array()
    );
    $idx['patients'][] = &$np;
    return $np;
}

/* ================= 主流程 ================= */

mv_ensure_dirs();
$action = isset($_GET['action']) ? $_GET['action'] : '';

// ping 免登录(前端探测服务器与登录状态)
if ($action === '' || $action === 'ping') {
    mv_session_start();
    $user = isset($_SESSION['mv_user']) ? $_SESSION['mv_user'] : null;
    $role = null;
    if ($user) {
        $accounts = mv_load_accounts();
        if (isset($accounts[$user]) && !mv_account_expired($accounts[$user])) {
            $role = $accounts[$user]['role'];
        } else {
            $user = null;
            unset($_SESSION['mv_user'], $_SESSION['mv_role']);
        }
    }
    mv_json(array('ok' => true, 'version' => MV_VERSION, 'server' => true, 'auth' => true, 'user' => $user, 'role' => $role,
        'canExport' => ($role === 'admin') ? true : (bool)($_SESSION['mv_can_export'] ?? false)));
}

$mutating = in_array($action, array('tmpbegin', 'tmpfile', 'tmpzip', 'chunk', 'commit', 'delete-study', 'delete-patient', 'edit-patient', 'login', 'logout', 'account-add', 'account-del', 'account-setpass', 'account-renew'), true);

if ($mutating && $action !== 'login') {
    // CSRF 加固: 变更操作要求自定义头(跨站表单无法携带)
    if (!isset($_SERVER['HTTP_X_MV'])) mv_fail('缺少请求头', 403);
}

mv_auth_check();

try {
    switch ($action) {

        case '': case 'ping':
            mv_json(array('ok' => true, 'version' => MV_VERSION, 'server' => true, 'auth' => defined('MV_USER') && MV_USER !== ''));
            break;

        case 'list': {
            mv_gc_tmp();
            $idx = mv_index_load();
            mv_migrate_sids($idx);
            $q = isset($_GET['q']) ? mv_mb_lower(trim($_GET['q'])) : '';
            $out = array();
            foreach ($idx['patients'] as $p) {
                $studies = array();
                $instances = 0; $mods = array(); $lastDate = '';
                foreach ($p['studies'] as $st) {
                    $sc = 0; $smods = array();
                    foreach ($st['series'] as $se) {
                        foreach ($se['files'] as $f) $sc += max(1, (int)$f['frames']);
                        if (!empty($se['modality'])) { $smods[$se['modality']] = 1; $mods[$se['modality']] = 1; }
                    }
                    $studies[] = array(
                        'uid' => $st['uid'], 'sid' => isset($st['sid']) ? $st['sid'] : '', 'date' => $st['date'], 'desc' => $st['desc'],
                        'accession' => isset($st['accession']) ? $st['accession'] : '',
                        'seriesCount' => count($st['series']), 'instanceCount' => $sc,
                        'modalities' => array_keys($smods)
                    );
                    $instances += $sc;
                    if ($st['date'] > $lastDate) $lastDate = $st['date'];
                }
                usort($studies, function ($a, $b) { return strcmp($b['date'], $a['date']); });
                $row = array(
                    'dir' => $p['dir'], 'id' => $p['id'], 'name' => $p['name'],
                    'birth' => $p['birth'], 'sex' => $p['sex'],
                    'studyCount' => count($studies), 'instanceCount' => $instances,
                    'lastStudyDate' => $lastDate, 'modalities' => array_keys($mods),
                    'studies' => $studies
                );
                if ($q !== '') {
                    $hay = mv_mb_lower($p['name'] . ' ' . $p['id'] . ' ' . implode(' ', array_column($studies, 'desc')));
                    if (strpos($hay, $q) === false) continue;
                }
                $out[] = $row;
            }
            usort($out, function ($a, $b) { return strcmp($b['lastStudyDate'], $a['lastStudyDate']); });
            mv_json(array('patients' => $out));
            break;
        }

        case 'study': {
            // 逻辑主键为 sid; 兼容旧 ?uid=(StudyInstanceUID, 全局唯一时命中)
            $sid = isset($_GET['sid']) ? $_GET['sid'] : '';
            $uid = isset($_GET['uid']) ? $_GET['uid'] : '';
            if ($sid === '' && $uid === '') mv_fail('缺少 sid');
            $idx = mv_index_load();
            mv_migrate_sids($idx);
            $hits = 0;
            foreach ($idx['patients'] as $p) {
                foreach ($p['studies'] as $st) {
                    if ($sid !== '' ? $st['sid'] !== $sid : $st['uid'] !== $uid) continue;
                    $hits++;
                    if ($hits > 1) mv_fail('该检查号在多个患者下存在, 请从列表打开');
                    $stSafe = $st['sdir'];
                    $posCache = mv_pos_cache($p['dir'], $stSafe, $st);
                    $series = array();
                    foreach ($st['series'] as $sei => $se) {
                        $files = array();
                        foreach ($se['files'] as $f) {
                            $files[] = array(
                                'sop' => $f['sop'], 'no' => $f['no'], 'frames' => max(1, (int)$f['frames']),
                                'pd' => $p['dir'],
                                'st' => $stSafe, 'se' => mv_safe_uid($se['uid']), 'f' => $f['f']
                            );
                        }
                        // 普适拆分: 同序列内层位重复(交织 DWI/mDIXON 等) → 按层位出现序拆子序列
                        $posList = isset($posCache[$se['uid']]) ? $posCache[$se['uid']] : array();
                        foreach (mv_split_interleaved($se, $files, $posList) as $sub) {
                            $series[] = array(
                                'uid' => $sub['uid'], 'number' => $se['number'], 'desc' => $sub['desc'],
                                'modality' => $se['modality'], 'files' => $sub['files']
                            );
                        }
                    }
                    usort($series, function ($a, $b) { return (int)$a['number'] - (int)$b['number']; });
                    mv_json(array(
                        'patient' => array('id' => $p['id'], 'name' => $p['name'], 'birth' => $p['birth'], 'sex' => $p['sex']),
                        'study' => array('uid' => $st['uid'], 'sid' => $st['sid'], 'date' => $st['date'], 'desc' => $st['desc'], 'series' => $series)
                    ));
                }
            }
            mv_fail('未找到该检查', 404);
            break;
        }
        case 'file': {
            $pd = isset($_GET['pd']) ? $_GET['pd'] : '';
            $st = isset($_GET['st']) ? $_GET['st'] : '';
            $se = isset($_GET['se']) ? $_GET['se'] : '';
            $f = isset($_GET['f']) ? $_GET['f'] : '';
            if (!mv_check_id($pd) || !mv_check_id($st) || !mv_check_id($se) || !mv_check_id($f)) mv_fail('非法参数');
            $path = MV_FILES_DIR . '/' . $pd . '/' . $st . '/' . $se . '/' . $f . '.dcm';
            $real = realpath($path);
            if ($real === false || strpos($real, realpath(MV_FILES_DIR)) !== 0 || !is_file($real)) mv_fail('文件不存在', 404);
            header('Content-Type: application/dicom');
            header('Content-Length: ' . filesize($real));
            header('Cache-Control: private, max-age=86400');
            readfile($real);
            exit;
        }

        case 'chunk': {
            // 分块上传: 大文件按 8MB 切块逐个 POST, 规避超大单请求(慢且易超时)
            // 参数: batch, kind=zip|file, name, index, total; 文件字段 chunk
            if (empty($_FILES['chunk'])) mv_fail('未收到数据块');
            $uf = $_FILES['chunk'];
            if ($uf['error'] === UPLOAD_ERR_INI_SIZE || $uf['error'] === UPLOAD_ERR_FORM_SIZE) {
                mv_fail('数据块超过 PHP 上传限制(' . ini_get('upload_max_filesize') . ')');
            }
            if ($uf['error'] !== UPLOAD_ERR_OK) mv_fail('上传失败 (code ' . $uf['error'] . ')');
            $batch = isset($_POST['batch']) ? $_POST['batch'] : '';
            $kind = ($_GET['kind'] ?? $_POST['kind'] ?? '') === 'zip' ? 'zip' : 'file';
            $name = isset($_POST['name']) ? $_POST['name'] : 'upload';
            $index = (int)($_POST['index'] ?? -1);
            $total = (int)($_POST['total'] ?? 0);
            if (!mv_check_id($batch) || $total < 1 || $index < 0 || $index >= $total) mv_fail('非法参数');
            $dir = MV_TMP_DIR . '/' . $batch;
            if (!is_dir($dir)) mv_fail('批次不存在,请重新导入');

            $metaFile = $dir . '/.chunkmeta.json';
            $meta = is_file($metaFile) ? json_decode((string)file_get_contents($metaFile), true) : null;
            if (!is_array($meta)) $meta = array('received' => 0, 'size' => 0);
            $recv = (int)$meta['received'];
            if ($index === $recv - 1) {
                // 幂等: 客户端重试上一块(响应丢失场景), 不重复追加
                mv_json(array('ok' => true, 'received' => $recv, 'size' => $meta['size'], 'dup' => true));
            }
            if ($index !== $recv) mv_fail('数据块乱序(期望 ' . $recv . ',收到 ' . $index . ')');
            // 块完整性: 客户端声明每块字节数, 不符说明传输被截断(不推进进度, 客户端会重试)
            $cs = isset($_POST['cs']) ? (int)$_POST['cs'] : 0;
            if ($cs > 0 && $uf['size'] != $cs) mv_fail('数据块不完整(收到 ' . $uf['size'] . ' 字节, 应为 ' . $cs . ')');
            $part = $dir . '/.upload.part';
            $fo = @fopen($part, 'ab');
            if (!$fo) mv_fail('写入分块失败(检查目录权限)', 500);
            $fi = @fopen($uf['tmp_name'], 'rb');
            if ($fi) {
                while (!feof($fi)) { $b = fread($fi, 1048576); if ($b !== '' && $b !== false) fwrite($fo, $b); }
                fclose($fi);
            }
            fclose($fo);
            clearstatcache();
            $meta['received'] = $index + 1;
            $meta['size'] = filesize($part);
            @file_put_contents($metaFile, json_encode($meta));

            // 最后一块: 完成落盘
            if ($index === $total - 1) {
                @unlink($metaFile);
                if ($kind === 'zip') {
                    $list = mv_zip_extract_dicom($part, $dir);
                    @unlink($part);
                    if (count($list) === 0) mv_fail('ZIP 中未找到 DICOM 文件(.dcm 或含 DICM 头)');
                    mv_json(array('files' => $list));
                } else {
                    $id = bin2hex(random_bytes(6));
                    if (!@rename($part, $dir . '/' . $id . '.dcm')) mv_fail('保存暂存文件失败', 500);
                    mv_json(array('files' => array(array('id' => $id, 'name' => $name, 'size' => $meta['size']))));
                }
            }
            mv_json(array('ok' => true, 'received' => $meta['received'], 'size' => $meta['size']));
            break;
        }

        case 'tmpbegin': {
            $batch = bin2hex(random_bytes(8));
            if (!@mkdir(MV_TMP_DIR . '/' . $batch, 0770, true)) mv_fail('暂存目录创建失败', 500);
            mv_json(array('batch' => $batch));
            break;
        }

        case 'tmpfile': {
            // POST 整体超限时 PHP 会丢弃所有 POST/FILES 数据
            if (empty($_POST) && empty($_FILES) && isset($_SERVER['CONTENT_LENGTH']) && (int)$_SERVER['CONTENT_LENGTH'] > 0) {
                mv_fail('上传数据超过 PHP post_max_size(' . ini_get('post_max_size') . '),请在 Web Station PHP 设置中调大');
            }
            $batch = isset($_POST['batch']) ? $_POST['batch'] : '';
            if (!mv_check_id($batch)) mv_fail('非法批次');
            $dir = MV_TMP_DIR . '/' . $batch;
            if (!is_dir($dir)) mv_fail('批次不存在,请重新导入');

            $out = array();
            $saveOne = function ($tmpName, $realName, $errCode) use ($dir, &$out) {
                if ($errCode === UPLOAD_ERR_INI_SIZE || $errCode === UPLOAD_ERR_FORM_SIZE) {
                    mv_fail('单个文件超过 PHP 上传大小限制(' . ini_get('upload_max_filesize') . '),请在 Web Station PHP 设置中调大');
                }
                if ($errCode !== UPLOAD_ERR_OK) mv_fail('上传失败 (code ' . $errCode . ')');
                if (!is_uploaded_file($tmpName)) mv_fail('无效的上传文件');
                $id = bin2hex(random_bytes(6));
                if (!@move_uploaded_file($tmpName, $dir . '/' . $id . '.dcm')) mv_fail('保存暂存文件失败(检查目录权限)', 500);
                $out[] = array('id' => $id, 'name' => $realName, 'size' => filesize($dir . '/' . $id . '.dcm'));
            };

            if (isset($_FILES['files'])) {
                // 批量: 多文件字段 files[] + names[]
                $names = isset($_POST['names']) && is_array($_POST['names']) ? $_POST['names'] : array();
                $list = $_FILES['files'];
                $cnt = is_array($list['name']) ? count($list['name']) : 1;
                for ($i = 0; $i < $cnt; $i++) {
                    $realName = isset($names[$i]) ? $names[$i] : (is_array($list['name']) ? $list['name'][$i] : $list['name']);
                    $tmpName = is_array($list['tmp_name']) ? $list['tmp_name'][$i] : $list['tmp_name'];
                    $errCode = is_array($list['error']) ? $list['error'][$i] : $list['error'];
                    $saveOne($tmpName, $realName, $errCode);
                }
            } elseif (isset($_FILES['file'])) {
                // 单文件(兼容)
                $saveOne($_FILES['file']['tmp_name'], basename($_FILES['file']['name']), $_FILES['file']['error']);
            } else {
                mv_fail('未收到文件。若文件较大,请在 Web Station 的 PHP 设置中调大 upload_max_filesize / post_max_size');
            }
            mv_json(array('files' => $out));
            break;
        }

        case 'tmpzip': {
            if (empty($_FILES['file'])) mv_fail('未收到文件');
            $uf = $_FILES['file'];
            if ($uf['error'] === UPLOAD_ERR_INI_SIZE || $uf['error'] === UPLOAD_ERR_FORM_SIZE) {
                mv_fail('ZIP 超过 PHP 上传大小限制(' . ini_get('upload_max_filesize') . '),请在 Web Station PHP 设置中调大,或解压后选择文件夹导入');
            }
            if ($uf['error'] !== UPLOAD_ERR_OK) mv_fail('上传失败 (code ' . $uf['error'] . ')');
            $batch = isset($_POST['batch']) ? $_POST['batch'] : '';
            if (!mv_check_id($batch)) mv_fail('非法批次');
            $dir = MV_TMP_DIR . '/' . $batch;
            if (!is_dir($dir)) mv_fail('批次不存在,请重新导入');
            $list = mv_zip_extract_dicom($uf['tmp_name'], $dir);
            if (count($list) === 0) mv_fail('ZIP 中未找到 DICOM 文件(.dcm 或含 DICM 头)');
            mv_json(array('files' => $list));
            break;
        }

        case 'tmpmeta': {
            $batch = isset($_GET['batch']) ? $_GET['batch'] : '';
            $id = isset($_GET['id']) ? $_GET['id'] : '';
            $len = isset($_GET['len']) ? (int)$_GET['len'] : 524288;
            if (!mv_check_id($batch) || !mv_check_id($id)) mv_fail('非法参数');
            $len = max(1024, min($len, 16777216));
            $path = MV_TMP_DIR . '/' . $batch . '/' . $id . '.dcm';
            if (!is_file($path)) mv_fail('文件不存在', 404);
            header('Content-Type: application/octet-stream');
            $fp = fopen($path, 'rb');
            echo fread($fp, $len);
            fclose($fp);
            exit;
        }

        case 'commit': {
            $j = mv_body_json();
            $defBatch = isset($j['batch']) ? $j['batch'] : '';
            $studies = isset($j['studies']) ? $j['studies'] : array();
            if (!is_array($studies) || count($studies) === 0) mv_fail('没有可导入的检查');
            $usedBatches = array();
            $patient = isset($j['patient']) ? $j['patient'] : array();

            $lock = mv_index_lock();
            $idx = mv_index_load();
            mv_migrate_sids($idx);
            $pat = &mv_find_patient($idx, isset($patient['id']) ? $patient['id'] : '', isset($patient['name']) ? $patient['name'] : '', isset($patient['birth']) ? $patient['birth'] : '');
            // 以确认后的信息为准
            $pat['id'] = trim((string)(isset($patient['id']) ? $patient['id'] : $pat['id']));
            $pat['name'] = (string)(isset($patient['name']) ? $patient['name'] : $pat['name']);
            $pat['birth'] = (string)(isset($patient['birth']) ? $patient['birth'] : $pat['birth']);
            $pat['sex'] = (string)(isset($patient['sex']) ? $patient['sex'] : $pat['sex']);

            $added = 0; $dups = 0; $studiesNew = 0; $studiesMerged = 0; $missing = 0;
            $transferredFrom = '';
            foreach ($studies as $st) {
                $studyUid = trim((string)(isset($st['uid']) ? $st['uid'] : ''));
                if ($studyUid === '') continue;

                unset($target);
                foreach ($pat['studies'] as &$ex) { if ($ex['uid'] === $studyUid) { $target = &$ex; break; } }
                unset($ex);
                if (!isset($target) || !$target) {
                    $target = array('uid' => $studyUid, 'sid' => bin2hex(random_bytes(8)), 'sdir' => '',
                        'date' => (string)(isset($st['date']) ? $st['date'] : ''),
                        'desc' => (string)(isset($st['desc']) ? $st['desc'] : ''), 'accession' => '', 'series' => array());
                    $target['sdir'] = $target['sid'];
                    $pat['studies'][] = &$target;
                    $studiesNew++;
                } else {
                    $studiesMerged++;
                    if (!empty($st['date'])) $target['date'] = (string)$st['date'];
                    if (!empty($st['desc'])) $target['desc'] = (string)$st['desc'];
                }
                if (isset($st['accession'])) $target['accession'] = (string)$st['accession'];
                $stSafe = $target['sdir'];   // 目录名: 新检查=sid, 存量=原目录名

                foreach ((isset($st['series']) ? $st['series'] : array()) as $se) {
                    $seUid = trim((string)(isset($se['uid']) ? $se['uid'] : ''));
                    if ($seUid === '') continue;
                    $seSafe = mv_safe_uid($seUid);
                    unset($seTarget);
                    foreach ($target['series'] as &$ex) { if ($ex['uid'] === $seUid) { $seTarget = &$ex; break; } }
                    unset($ex);
                    if (!isset($seTarget) || !$seTarget) {
                        $seTarget = array(
                            'uid' => $seUid, 'number' => (int)(isset($se['number']) ? $se['number'] : 0),
                            'desc' => (string)(isset($se['desc']) ? $se['desc'] : ''),
                            'modality' => (string)(isset($se['modality']) ? $se['modality'] : ''),
                            'files' => array()
                        );
                        $target['series'][] = &$seTarget;
                    }
                    foreach ((isset($se['files']) ? $se['files'] : array()) as $f) {
                        $fid = isset($f['id']) ? $f['id'] : '';
                        $fbatch = isset($f['batch']) ? $f['batch'] : $defBatch;
                        $sop = isset($f['sop']) ? $f['sop'] : '';
                        if (!mv_check_id($fid) || !mv_check_id($fbatch) || $sop === '') { $missing++; continue; }
                        $src = MV_TMP_DIR . '/' . $fbatch . '/' . $fid . '.dcm';
                        if (!is_file($src)) { $missing++; continue; }
                        $usedBatches[$fbatch] = true;
                        $fSafe = mv_safe_uid($sop);
                        // 已存在同 SOP → 跳过
                        $exists = false;
                        foreach ($seTarget['files'] as $exf) { if ($exf['sop'] === $sop) { $exists = true; break; } }
                        $dstDir = MV_FILES_DIR . '/' . $pat['dir'] . '/' . $stSafe . '/' . $seSafe;
                        if ($exists || is_file($dstDir . '/' . $fSafe . '.dcm')) {
                            @unlink($src);
                            $dups++;
                            continue;
                        }
                        if (!is_dir($dstDir) && !@mkdir($dstDir, 0770, true)) continue;
                        if (@rename($src, $dstDir . '/' . $fSafe . '.dcm')) {
                            $seTarget['files'][] = array(
                                'sop' => $sop,
                                'no' => (int)(isset($f['no']) ? $f['no'] : 0),
                                'frames' => (int)(isset($f['frames']) ? $f['frames'] : 1),
                                'f' => $fSafe
                            );
                            $added++;
                        }
                    }
                }
            }
            unset($pat);
            mv_index_save($idx);
            mv_index_unlock($lock);
            // 清理已空的批次目录;非空批次(含其他待导入文件)留给 GC 兜底
            foreach (array_keys($usedBatches) as $b) {
                $d = MV_TMP_DIR . '/' . $b;
                if (is_dir($d)) {
                    $left = array_values(array_diff(scandir($d), array('.', '..')));
                    if (count($left) === 0) mv_rmrf($d);
                }
            }
            mv_json(array('ok' => true, 'added' => $added, 'dups' => $dups, 'missing' => $missing, 'studiesNew' => $studiesNew, 'studiesMerged' => $studiesMerged, 'transferredFrom' => $transferredFrom));
            break;
        }

        case 'delete-study': {
            $j = mv_body_json();
            $sid = isset($j['sid']) ? $j['sid'] : '';
            $uid = isset($j['uid']) ? $j['uid'] : '';
            if ($sid === '' && $uid === '') mv_fail('缺少参数');
            $lock = mv_index_lock();
            $idx = mv_index_load();
            mv_migrate_sids($idx);
            foreach ($idx['patients'] as $pi => $p) {
                foreach ($p['studies'] as $si => $st) {
                    if ($sid !== '' ? $st['sid'] !== $sid : $st['uid'] !== $uid) continue;
                    mv_rmrf(MV_FILES_DIR . '/' . $p['dir'] . '/' . $st['sdir']);
                    array_splice($idx['patients'][$pi]['studies'], $si, 1);
                    if (count($idx['patients'][$pi]['studies']) === 0) {
                        @rmdir(MV_FILES_DIR . '/' . $p['dir']);
                        array_splice($idx['patients'], $pi, 1);
                    }
                    mv_index_save($idx);
                    mv_index_unlock($lock);
                    mv_json(array('ok' => true));
                }
            }
            mv_index_unlock($lock);
            mv_fail('未找到该检查', 404);
            break;
        }

        case 'delete-patient': {
            $j = mv_body_json();
            $dir = isset($j['dir']) ? $j['dir'] : '';
            if (!mv_check_id($dir)) mv_fail('非法参数');
            $lock = mv_index_lock();
            $idx = mv_index_load();
            foreach ($idx['patients'] as $pi => $p) {
                if ($p['dir'] !== $dir) continue;
                mv_rmrf(MV_FILES_DIR . '/' . $dir);
                array_splice($idx['patients'], $pi, 1);
                mv_index_save($idx);
                mv_index_unlock($lock);
                mv_json(array('ok' => true));
            }
            mv_fail('未找到该患者', 404);
            break;
        }

        case 'edit-patient': {
            $j = mv_body_json();
            $dir = isset($j['dir']) ? $j['dir'] : '';
            if (!mv_check_id($dir)) mv_fail('非法参数');
            $lock = mv_index_lock();
            $idx = mv_index_load();
            foreach ($idx['patients'] as &$p) {
                if ($p['dir'] !== $dir) continue;
                foreach (array('id', 'name', 'birth', 'sex') as $k) {
                    if (isset($j[$k])) $p[$k] = trim((string)$j[$k]);
                }
                mv_index_save($idx);
                mv_index_unlock($lock);
                mv_json(array('ok' => true));
            }
            unset($p);
            mv_index_unlock($lock);
            mv_fail('未找到该患者', 404);
            break;
        }

        case 'export': {
            if (($GLOBALS['mv_role'] ?? '') !== 'admin' && empty($GLOBALS['mv_can_export'])) mv_fail('该账号没有导出权限', 403);
            $sid = isset($_GET['sid']) ? $_GET['sid'] : '';
            $uid = isset($_GET['uid']) ? $_GET['uid'] : '';      // 兼容旧链接
            $dir = isset($_GET['dir']) ? $_GET['dir'] : '';      // 或患者目录(全部检查)
            if ($uid === '' && $dir === '') mv_fail('缺少参数');
            $idx = mv_index_load();
            mv_migrate_sids($idx);
            $files = array();
            $zipBase = '';
            $count = 0;
            $collect = function ($p, $st) use (&$files, &$count) {
                foreach ($st['series'] as $se) {
                    $seDir = mv_safe_name(($se['number'] !== '' ? sprintf('%02d', (int)$se['number']) . '-' : '') . ($se['desc'] !== '' ? $se['desc'] : $se['uid']));
                    foreach ($se['files'] as $f) {
                        $path = MV_FILES_DIR . '/' . $p['dir'] . '/' . $st['sdir'] . '/' . mv_safe_uid($se['uid']) . '/' . $f['f'] . '.dcm';
                        if (!is_file($path)) continue;
                        $files[] = array('path' => $path, 'name' => mv_safe_name($p['id'] !== '' ? $p['id'] : $p['name']) . '/' . mv_safe_name($st['date'] . ' ' . $st['desc']) . '/' . $seDir . '/' . sprintf('%06d', (int)$f['no']) . '.dcm');
                        $count++;
                    }
                }
            };
            foreach ($idx['patients'] as $p) {
                if ($dir !== '' && $p['dir'] !== $dir) continue;
                foreach ($p['studies'] as $st) {
                    if ($sid !== '' && $st['sid'] !== $sid) continue;
                    if ($sid === '' && $uid !== '' && $st['uid'] !== $uid) continue;
                    $collect($p, $st);
                    if ($zipBase === '') $zipBase = ($uid !== '' ? $p['name'] . '_' . $st['date'] . '_' . $st['desc'] : $p['name'] . '_全部检查');
                }
            }
            if ($count === 0) mv_fail('没有可导出的文件', 404);
            mv_zip_stream_out($files, $zipBase);
            break;
        }

        case 'logout': {
            mv_session_start();
            unset($_SESSION['mv_user'], $_SESSION['mv_role'], $_SESSION['mv_can_export']);
            mv_json(array('ok' => true));
            break;
        }

        case 'accounts-list': {
            mv_need_admin();
            $accounts = mv_load_accounts();
            $out = array();
            foreach ($accounts as $name => $a) {
                $out[] = array(
                    'name' => $name, 'role' => isset($a['role']) ? $a['role'] : 'user',
                    'expires' => isset($a['expires']) ? $a['expires'] : '',
                    'note' => isset($a['note']) ? $a['note'] : '',
                    'created' => isset($a['created']) ? $a['created'] : '',
                    'expired' => mv_account_expired($a),
                    'canExport' => ($a['role'] ?? '') === 'admin' ? true : !empty($a['can_export'])
                );
            }
            mv_json(array('accounts' => $out));
            break;
        }

        case 'account-add': {
            mv_need_admin();
            $b = mv_body_json();
            $name = trim((string)($b['name'] ?? ''));
            $pass = (string)($b['pass'] ?? '');
            $days = (int)($b['days'] ?? 7);
            $note = trim((string)($b['note'] ?? ''));
            if (!preg_match('/^[A-Za-z0-9_]{2,20}$/', $name)) mv_fail('用户名需为 2-20 位字母/数字/下划线');
            if (strlen($pass) < 4) mv_fail('密码至少 4 位');
            $days = max(1, min(3650, $days));
            $accounts = mv_load_accounts();
            if (isset($accounts[$name])) mv_fail('该用户名已存在');
            $accounts[$name] = array(
                'hash' => password_hash($pass, PASSWORD_DEFAULT),
                'role' => 'user',
                'can_export' => !empty($b['canExport']) ? 1 : 0,
                'expires' => date('YmdHis', time() + $days * 86400),
                'note' => $note !== '' ? $note : '临时账号',
                'created' => date('YmdHis')
            );
            mv_save_accounts($accounts);
            mv_json(array('ok' => true));
            break;
        }

        case 'account-del': {
            mv_need_admin();
            $b = mv_body_json();
            $name = trim((string)($b['name'] ?? ''));
            if ($name === ($GLOBALS['mv_user'] ?? '')) mv_fail('不能删除当前登录的账号');
            $accounts = mv_load_accounts();
            if (!isset($accounts[$name])) mv_fail('账号不存在', 404);
            unset($accounts[$name]);
            mv_save_accounts($accounts);
            mv_json(array('ok' => true));
            break;
        }

        case 'account-setpass': {
            mv_need_admin();
            $b = mv_body_json();
            $name = trim((string)($b['name'] ?? ''));
            $pass = (string)($b['pass'] ?? '');
            if (strlen($pass) < 4) mv_fail('密码至少 4 位');
            $accounts = mv_load_accounts();
            if (!isset($accounts[$name])) mv_fail('账号不存在', 404);
            $accounts[$name]['hash'] = password_hash($pass, PASSWORD_DEFAULT);
            mv_save_accounts($accounts);
            mv_json(array('ok' => true));
            break;
        }

        case 'account-renew': {
            mv_need_admin();
            $b = mv_body_json();
            $name = trim((string)($b['name'] ?? ''));
            $days = max(1, min(3650, (int)($b['days'] ?? 7)));
            $accounts = mv_load_accounts();
            if (!isset($accounts[$name])) mv_fail('账号不存在', 404);
            $base = max(time(), strtotime($accounts[$name]['expires'] ?: 'now'));
            $accounts[$name]['expires'] = date('YmdHis', $base + $days * 86400);
            mv_save_accounts($accounts);
            mv_json(array('ok' => true, 'expires' => $accounts[$name]['expires']));
            break;
        }

        default:
            mv_fail('未知操作: ' . $action, 404);
    }
} catch (Throwable $e) {
    mv_fail('服务器错误: ' . $e->getMessage(), 500);
}
