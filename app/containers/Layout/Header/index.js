import React from 'react';
import { Link } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { func } from 'prop-types';
import { push } from 'connected-react-router';

import messages from './messages';

import { NavBar, NavHeader } from './Styles';

import { logout } from '../../../core/auth/actions';
import saga from './saga';
import { useInjectSaga } from '../../../core/runtime/injectSaga';

const Header = props => {
  useInjectSaga({ key: 'logout', saga });
  const { onLogout } = props;

  return (
    <NavBar>
      <NavHeader>
        <Link to="/" className="nav-link">
          Home
        </Link>

        <Link to="/post" className="nav-link">
          Post
        </Link>
      </NavHeader>
      <NavHeader>
        <a className="nav-link" />

        <a className="nav-link" onClick={e => onLogout(e)}>
          <FormattedMessage {...messages.logout} />
        </a>
      </NavHeader>
    </NavBar>
  );
};

Header.propTypes = {
  onLogout: func.isRequired,
};

const mapDispatchToProps = dispatch => {
  return {
    onLogout: evt => {
      dispatch(logout());
      dispatch(push('/login'));
    },
  };
};

const withConnect = connect(
  null,
  mapDispatchToProps
);

export default compose(withConnect)(Header);
